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
// Large bounding boxes (~double) so the raster layers cover the wider metro area.
//
// telangana is a whole STATE, not a metro box: this bbox is the real extent of
// all 10,718 villages (from vb_soi_ts.shp, reprojected to WGS84) plus a small
// ~0.05deg buffer on each side, not a doubled metro box like the city entries.
const CITY_BOXES = {
  ahmedabad: [72.35, 22.8, 72.82, 23.25],
  telangana: [77.19, 15.79, 81.37, 19.97],
  mumbai: [72.65, 18.8, 73.1, 19.4],
};
function cityGeom(cityKey) {
  const box = CITY_BOXES[cityKey];
  if (!box) throw new Error("unknown city: " + cityKey);
  return ee.Geometry.Rectangle(box);

  // --- Municipal-boundary option (when Prathyu shares the asset IDs) ---
  // const MUNI = {
  //   ahmedabad: "projects/xxx/assets/ahmedabad_muni",
  //   mumbai:    "projects/xxx/assets/mumbai_muni",
  //   telangana: "projects/xxx/assets/telangana_villages",
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
// Default keeps Prathyu's strict 10%. Only May for Mumbai/Telangana relaxes to
// 25%, because those specific scenes have no image under 10% cloud.
// (carried over from the old Hyderabad exception since Telangana now covers
// the same Hyderabad scenes at state scale — revisit if May 25% turns out to
// be too loose/tight once you see real state-wide coverage.)
function computeIndices(geom, year, month, cityKey) {
  let cloudMax = 10;
  if (month === 5 && (cityKey === "mumbai" || cityKey === "telangana")) {
    cloudMax = 25;
  }

  const start0 = ee.Date.fromYMD(year, month, 1);
  const end0 = start0.advance(1, "month");
  // Telangana spans multiple Landsat path/rows - a single calendar month can
  // leave some path/rows with zero passes, showing up as blank/transparent
  // gaps in the composite. Widen the window so every path/row gets at least
  // one look, while still centering on the selected month. Ahmedabad/Mumbai
  // are small enough to sit within one or two path/rows, so they don't need
  // this and keep the original tight month window.
  const start = cityKey === "telangana" ? start0.advance(-15, "day") : start0;
  const end = cityKey === "telangana" ? end0.advance(15, "day") : end0;
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

// ---- UHI hotspots (faithful re-implementation of the GEE UHI script) ----
// Per-city threshold: Ahmedabad 0.38, Telangana 0.40, Mumbai 0.44.
// NOTE: Telangana is a full state now, not just Hyderabad city - a single
// fixed threshold may over/under-flag hotspots given how much more spatial
// variety a whole state has vs. one city. Kept at 0.40 (the old Hyderabad
// value) for now; watch the results and re-tune per-district if needed.
const UHI_THRESHOLDS = { ahmedabad: 0.38, telangana: 0.5, mumbai: 0.44 };

// >>> PASTE MUNICIPAL BOUNDARY GEE ASSET IDs HERE when available. <<<
// e.g. ahmedabad: "projects/argon-key-461118-u4/assets/ahmedabad_municipal"
// Leave "" to fall back to the bounding box.
const MUNI_ASSETS = {
  // >>> after uploading ahmedabad_wards.zip to GEE, paste its asset ID here <<<
  ahmedabad: "projects/argon-key-461118-u4/assets/ahmedabad_wards",
  // >>> after uploading TS_District_Boundary (official 33 Telangana
  // districts, from Charvi) to GEE, paste its asset ID here <<<
  telangana: "projects/argon-key-461118-u4/assets/telangana_districts",
  mumbai: "projects/argon-key-461118-u4/assets/mumbai_wards",
};

// returns the municipal-boundary geometry if an asset is set, else the box
function uhiClipGeom(cityKey, boxGeom) {
  const assetId = MUNI_ASSETS[cityKey];
  if (assetId && assetId.length > 0) {
    return ee.FeatureCollection(assetId).geometry();
  }
  return boxGeom;
}

// Boundary clip - same simple pattern proven to work for Ahmedabad/Mumbai's
// small ward collections: clip directly to the asset's geometry.
// IMPORTANT for Telangana: MUNI_ASSETS.telangana must point to the separate
// single-polygon STATE OUTLINE asset (telangana_outline), NOT the raw
// 10,718-village collection - clipping to the raw village FeatureCollection
// (or dissolving/painting it at runtime) is too heavy and either errors out
// ("Description length exceeds maximum") or times out per-tile. The outline
// asset is a single simplified polygon (~424 vertices) computed once
// locally from the same villages via unary_union, so this stays exactly as
// lightweight as the city ward clips.
function clipToBoundary(image, cityKey, boxGeom) {
  const assetId = MUNI_ASSETS[cityKey];
  if (assetId && assetId.length > 0) {
    const outline = ee.FeatureCollection(assetId).geometry();
    return image.clip(outline);
  }
  return image.clip(boxGeom);
}

function uhiHotspots(geom, cityKey) {
  // seasonal (Mar–Jun), all years 2020–2026, like her script
  const col = ee
    .ImageCollection("LANDSAT/LC08/C02/T1_L2")
    .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_L2"))
    .filterBounds(geom)
    .filter(ee.Filter.calendarRange(2020, 2026, "year"))
    .filter(ee.Filter.calendarRange(3, 6, "month"));
  const composite = col.median().clip(geom);

  const ndvi = composite
    .expression("(NIR-RED)/(NIR+RED)", {
      NIR: composite.select("SR_B5"),
      RED: composite.select("SR_B4"),
    })
    .rename("NDVI");
  const wi = composite
    .expression("(GREEN-NIR)/(GREEN+NIR)", {
      GREEN: composite.select("SR_B3"),
      NIR: composite.select("SR_B5"),
    })
    .rename("WI");
  const bi = composite
    .expression("(SWIR-NIR)/(SWIR+NIR)", {
      SWIR: composite.select("SR_B6"),
      NIR: composite.select("SR_B5"),
    })
    .rename("BI");
  const lst = composite
    .expression("(TH*0.00341802+149.0)-273.15", {
      TH: composite.select("ST_B10"),
    })
    .rename("LST");
  const raw = ndvi.addBands(wi).addBands(bi).addBands(lst);

  function norm(band, isNeg) {
    const stats = raw.select(band).reduceRegion({
      reducer: ee.Reducer.minMax(),
      geometry: geom,
      scale: 150,
      maxPixels: 1e9,
    });
    const mn = ee.Number(stats.get(band + "_min"));
    const mx = ee.Number(stats.get(band + "_max"));
    const n = raw.select(band).subtract(mn).divide(mx.subtract(mn));
    return (isNeg ? ee.Image(1).subtract(n) : n).rename(band + "_norm");
  }
  const stacked = norm("NDVI", false)
    .addBands(norm("WI", false))
    .addBands(norm("BI", true))
    .addBands(norm("LST", true));

  const weighted = stacked
    .expression("(0.20*NDVI)+(0.20*WI)+(0.30*BI)+(0.30*LST)", {
      NDVI: stacked.select("NDVI_norm"),
      WI: stacked.select("WI_norm"),
      BI: stacked.select("BI_norm"),
      LST: stacked.select("LST_norm"),
    })
    .rename("Weighted");

  const threshold = UHI_THRESHOLDS[cityKey] ?? 0.4;
  const rawHot = weighted.lte(threshold);
  const urbanMask = stacked.select("BI_norm").lte(0.6);
  const hotspots = rawHot.and(urbanMask).selfMask().rename("UHI");

  // clip to municipal boundary (via rasterized mask) if the asset is set, else to the box
  return clipToBoundary(hotspots, cityKey, geom);
}

async function uhiTileUrl(cityKey) {
  const geom = cityGeom(cityKey);
  return imageToUrl(uhiHotspots(geom, cityKey), { palette: ["#a00400"] });
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
  // clip to the real boundary (village/ward asset) if one is set, else the
  // box - same helper used for UHI, so LST/NDVI/NDWI/NDBI stop spilling past
  // Telangana's actual outline into neighbouring states.
  return imageToUrl(clipToBoundary(image, cityKey, geom), vis);
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

module.exports = { init, isReady, indexTileUrl, buildingsTileUrl, uhiTileUrl };
