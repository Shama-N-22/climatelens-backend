// ee-service.js
// Earth Engine logic: auth + the same index math as the GEE script,
// exposed as functions that return fresh tile URLs.

const ee = require("@google/earthengine");
const fs = require("fs");

// ---- load the service-account key (env var for deploy, file for local) ----
function loadKey() {
  if (process.env.GEE_KEY_JSON) return JSON.parse(process.env.GEE_KEY_JSON);
  const p = process.env.GEE_KEY_PATH || "./service-account.json";
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

let ready = false;
function init() {
  return new Promise((resolve, reject) => {
    const key = loadKey();
    ee.data.authenticateViaPrivateKey(
      key,
      () =>
        ee.initialize(
          null,
          null,
          () => {
            ready = true;
            resolve();
          },
          reject,
        ),
      (err) => reject(err),
    );
  });
}
function isReady() {
  return ready;
}

// ---- city geometries ----
// Bounding boxes from the GEE script. To clip to real MUNICIPAL BOUNDARIES,
// replace the returned geometry with a FeatureCollection asset (see comment).
// Bigger bounding boxes to cover the whole city / ring-road extent.
const CITY_BOXES = {
  ahmedabad: [72.45, 22.9, 72.72, 23.15],
  hyderabad: [78.3, 17.28, 78.62, 17.55],
  mumbai: [72.77, 18.89, 73.0, 19.28],
};
function cityGeom(cityKey) {
  const box = CITY_BOXES[cityKey];
  if (!box) throw new Error("unknown city: " + cityKey);
  return ee.Geometry.Rectangle(box);

  // --- Municipal-boundary option (when Prathyu shares the asset IDs) ---
  // const MUNI = {
  //   ahmedabad: "projects/xxx/assets/ahmedabad_muni",
  //   mumbai:    "projects/xxx/assets/mumbai_muni",
  //   hyderabad: "projects/xxx/assets/hyderabad_muni",
  // };
  // return ee.FeatureCollection(MUNI[cityKey]).geometry();
}

// ---- cloud mask (same as the script) ----
function maskClouds(image) {
  const qa = image.select("QA_PIXEL");
  const cloud = 1 << 3,
    shadow = 1 << 4;
  const mask = qa.bitwiseAnd(cloud).eq(0).and(qa.bitwiseAnd(shadow).eq(0));
  return image.updateMask(mask);
}

// ---- indices (same formulas as the script) + cloud filter ----
// Default keeps Prathyu's strict 10%. Only May for Mumbai/Hyderabad relaxes to
// 25%, because those specific scenes have no image under 10% cloud.
function computeIndices(geom, year, month, cityKey) {
  let cloudMax = 10;
  if (month === 5 && (cityKey === "mumbai" || cityKey === "hyderabad")) {
    cloudMax = 25;
  }

  const start = ee.Date.fromYMD(year, month, 1);
  const end = start.advance(1, "month");
  const col = ee
    .ImageCollection("LANDSAT/LC08/C02/T1_L2")
    .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_L2"))
    .filterBounds(geom)
    .filterDate(start, end)
    .filter(ee.Filter.lt("CLOUD_COVER", cloudMax))
    .map(maskClouds);

  const composite = col.median().clip(geom);
  const ndvi = composite
    .expression("(NIR - RED) / (NIR + RED)", {
      NIR: composite.select("SR_B5"),
      RED: composite.select("SR_B4"),
    })
    .rename("NDVI");
  const wi = composite
    .expression("(GREEN - NIR) / (GREEN + NIR)", {
      GREEN: composite.select("SR_B3"),
      NIR: composite.select("SR_B5"),
    })
    .rename("WI");
  const bi = composite
    .expression("(SWIR - NIR) / (SWIR + NIR)", {
      SWIR: composite.select("SR_B6"),
      NIR: composite.select("SR_B5"),
    })
    .rename("BI");
  const lst = composite
    .expression("(TH * 0.00341802 + 149.0) - 273.15", {
      TH: composite.select("ST_B10"),
    })
    .rename("LST");
  return { lst, ndvi, wi, bi };
}

// ---- dynamic NDVI classification (real range split into 3) ----
function classifyNdvi(ndvi, geom) {
  const veg = ndvi.updateMask(ndvi.gte(0));
  const stats = veg.reduceRegion({
    reducer: ee.Reducer.max(),
    geometry: geom,
    scale: 90,
    maxPixels: 1e13,
    bestEffort: true,
  });
  const maxV = ee.Number(
    ee.Algorithms.If(stats.get("NDVI"), stats.get("NDVI"), 0.6),
  );
  const step = maxV.divide(3);
  return ee
    .Image(0)
    .where(ndvi.gte(0).and(ndvi.lt(step)), 1)
    .where(ndvi.gte(step).and(ndvi.lt(step.multiply(2))), 2)
    .where(ndvi.gte(step.multiply(2)), 3)
    .updateMask(ndvi.mask())
    .clip(geom);
}

// ---- visualization palettes (same as the script) ----
const VIS = {
  lst: {
    min: 15,
    max: 55,
    palette: ["#313695", "#74add1", "#fee090", "#f46d43", "#a50026"],
  },
  ndvi: {
    min: 0,
    max: 3,
    palette: ["#e0e0e0", "#c2e699", "#78c679", "#006837"],
  },
  ndbi: {
    min: -1.0,
    max: 0.5,
    palette: ["#ffffff", "#ffffff", "#fee0d2", "#fc9272", "#de2d26", "#a50f15"],
  },
  ndwi: {
    min: -1.0,
    max: 0.4,
    palette: ["#ffffff", "#ffffff", "#deebf7", "#9ecae1", "#4292c6", "#084594"],
  },
};

// ---- turn any EE image into a tile URL ----
function imageToUrl(image, vis) {
  return new Promise((resolve, reject) => {
    image.getMap(vis, (map, err) => {
      if (err) return reject(err);
      const url =
        map &&
        (map.urlFormat ||
          (map.mapid
            ? `https://earthengine.googleapis.com/v1/${map.mapid}/tiles/{z}/{x}/{y}`
            : null));
      if (!url)
        return reject(new Error("no tile url returned by Earth Engine"));
      resolve(url);
    });
  });
}

// ---- public functions used by the server ----
async function indexTileUrl(cityKey, year, month, layer) {
  const geom = cityGeom(cityKey);
  const idx = computeIndices(geom, year, month, cityKey);
  let image, vis;
  switch (layer) {
    case "ndvi":
      image = classifyNdvi(idx.ndvi, geom);
      vis = VIS.ndvi;
      break;
    case "lst":
      image = idx.lst;
      vis = VIS.lst;
      break;
    case "ndwi":
      image = idx.wi;
      vis = VIS.ndwi;
      break;
    case "ndbi":
      image = idx.bi;
      vis = VIS.ndbi;
      break;
    default:
      throw new Error("unknown layer: " + layer);
  }
  return imageToUrl(image, vis);
}

async function buildingsTileUrl(cityKey) {
  const geom = cityGeom(cityKey);
  const buildings = ee
    .FeatureCollection("GOOGLE/Research/open-buildings/v3/polygons")
    .filterBounds(geom)
    .filter("confidence >= 0.65");
  const styled = buildings.style({
    color: "#b8bcc4",
    fillColor: "00000000",
    width: 1,
  });
  return imageToUrl(styled, {});
}

module.exports = { init, isReady, indexTileUrl, buildingsTileUrl };
