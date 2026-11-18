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
  // ADDED Nov 2026: fall back to the all-India STATE_BOXES table (defined near
  // the bottom of this file) so every state in the dropdown works, not just
  // the three original city entries. Existing city behaviour is unchanged.
  const box = CITY_BOXES[cityKey] || STATE_BOXES[cityKey];
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
  // ADDED Nov 2026: every STATE (not just Telangana) spans several Landsat
  // path/rows, so they all need the widened window. Ahmedabad and Mumbai are
  // single-metro boxes and keep the original tight month window.
  const isMetro = cityKey === "ahmedabad" || cityKey === "mumbai";
  const start = isMetro ? start0 : start0.advance(-15, "day");
  const end = isMetro ? end0 : end0.advance(15, "day");
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
  // ADDED Nov 2026: no ward/district asset for this key, but if it is one of
  // the all-India states we can still clip to its real outline, taken from the
  // india_districts asset and simplified to 5 km (the same simplify tolerance
  // Charvi uses in her GEE script, which keeps the geometry light enough to
  // serve tiles). Falls back to the plain bounding box if anything is missing.
  if (STATE_BOXES[cityKey]) {
    return image.clip(stateOutline(cityKey));
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

// ---- per-district max LST (for the district popup's "Max temperature" stat) ----
async function districtMaxLST(cityKey, year, month) {
  const assetId = MUNI_ASSETS[cityKey];
  if (!assetId) throw new Error("no district/ward asset set for " + cityKey);
  const geom = cityGeom(cityKey);
  const idx = computeIndices(geom, year, month, cityKey);
  const districts = ee.FeatureCollection(assetId);
  const stats = idx.lst.reduceRegions({
    collection: districts,
    reducer: ee.Reducer.max(),
    scale: 150,
    tileScale: 4,
  });
  return new Promise((resolve, reject) => {
    stats.getInfo((result, err) => {
      if (err) return reject(err);
      const out = {};
      (result.features || []).forEach((f) => {
        const rawName =
          f.properties.District || f.properties.district || f.properties.name;
        if (!rawName) return;
        // Title-case to match the frontend geojson's "district" property casing
        const name = String(rawName)
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase());
        out[name] = f.properties.max;
      });
      resolve(out);
    });
  });
}

module.exports = {
  init,
  isReady,
  indexTileUrl,
  buildingsTileUrl,
  uhiTileUrl,
  districtMaxLST,
  districtBuildingCounts,
  // ADDED Nov 2026 - all-India extra layers
  riversTileUrl,
  rainfallTileUrl,
  lulcTileUrl,
  demTileUrl,
  slopeTileUrl,
  waterOccurrenceTileUrl,
  knownStates,
};

async function districtBuildingCounts(cityKey) {
  const assetId = MUNI_ASSETS[cityKey];
  if (!assetId) throw new Error("no district/ward asset set for " + cityKey);
  const districts = ee.FeatureCollection(assetId);
  const buildings = ee
    .FeatureCollection("GOOGLE/Research/open-buildings/v3/polygons")
    .filter("confidence >= 0.65");
  const withCounts = districts.map((f) => {
    const count = buildings.filterBounds(f.geometry()).size();
    return f.set("building_count", count);
  });
  return new Promise((resolve, reject) => {
    withCounts.getInfo((result, err) => {
      if (err) return reject(err);
      const out = {};
      (result.features || []).forEach((f) => {
        const rawName =
          f.properties.District || f.properties.district || f.properties.name;
        if (!rawName) return;
        const name = String(rawName)
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase());
        out[name] = f.properties.building_count;
      });
      resolve(out);
    });
  });
}


// ============================================================================
// ============  ADDED November 2026 - ALL-INDIA LAYERS  ======================
// ============================================================================
// Everything above this line is the original file, unchanged apart from the
// four spots marked "ADDED Nov 2026".
//
// What this block adds:
//   * STATE_BOXES  - bounding box for all 35 states/UTs, measured from the
//                    2011 Census district shapefile Charvi shared.
//   * stateOutline - the real outline of a state, read from the
//                    india_districts GEE asset and simplified to 5 km.
//   * Five new raster/vector layers requested for Heat, Flood and Landslide:
//        rivers, rainfall, LULC, DEM, slope   (+ JRC surface water)
//     Each one is a direct port of Charvi's GEE script.
// ============================================================================

// Upload of Census_2011 "2011_Dist" shapefile, shared with the
// urban-heat@... service account as Reader.
const INDIA_DISTRICTS_ASSET =
  "projects/argon-key-461118-u4/assets/india_districts";

// Bounding boxes measured from the shapefile itself (min lon, min lat,
// max lon, max lat). Keys match the slug the frontend sends.
const STATE_BOXES = {
  "telangana": [77.19, 15.79, 81.37, 19.97],   // Telangana (existing)
  "andaman-and-nicobar-islands": [92.21, 6.76, 94.28, 13.68],   // Andaman and Nicobar Islands
  "andhra-pradesh": [76.76, 12.62, 84.77, 19.17],   // Andhra Pradesh
  "arunachal-pradesh": [91.55, 26.65, 97.42, 29.46],   // Arunachal Pradesh
  "assam": [89.7, 24.13, 96.02, 27.97],   // Assam
  "bihar": [83.32, 24.26, 88.3, 27.52],   // Bihar
  "chandigarh": [76.7, 30.67, 76.85, 30.8],   // Chandigarh
  "chhattisgarh": [80.25, 17.79, 84.4, 24.11],   // Chhattisgarh
  "dadra-and-nagar-haveli-and-daman-and-diu": [70.87, 20.05, 73.22, 20.77],   // Dadra and Nagar Haveli and Daman and Diu
  "delhi": [76.84, 28.4, 77.35, 28.88],   // Delhi
  "goa": [73.68, 14.75, 74.34, 15.8],   // Goa
  "gujarat": [68.19, 20.12, 74.48, 24.71],   // Gujarat
  "haryana": [74.47, 27.65, 77.61, 30.93],   // Haryana
  "himachal-pradesh": [75.59, 30.38, 79.01, 33.25],   // Himachal Pradesh
  "jammu-and-kashmir": [73.88, 32.28, 76.8, 34.87],   // Jammu and Kashmir
  "jharkhand": [83.33, 21.97, 87.98, 25.35],   // Jharkhand
  "karnataka": [74.05, 11.58, 78.59, 18.48],   // Karnataka
  "kerala": [74.86, 8.29, 77.41, 12.8],   // Kerala
  "ladakh": [75.36, 32.34, 80.33, 35.99],   // Ladakh
  "lakshadweep": [71.73, 8.26, 74.12, 12.4],   // Lakshadweep
  "madhya-pradesh": [74.03, 21.07, 82.82, 26.87],   // Madhya Pradesh
  "maharashtra": [72.64, 15.61, 80.9, 22.03],   // Maharashtra
  "manipur": [92.97, 23.84, 94.75, 25.69],   // Manipur
  "meghalaya": [89.82, 25.03, 92.8, 26.12],   // Meghalaya
  "mizoram": [92.26, 21.94, 93.44, 24.52],   // Mizoram
  "nagaland": [93.33, 25.2, 95.24, 27.04],   // Nagaland
  "odisha": [81.39, 17.81, 87.49, 22.57],   // Odisha
  "puducherry": [75.53, 10.83, 82.31, 16.76],   // Puducherry
  "punjab": [73.89, 29.54, 76.94, 32.58],   // Punjab
  "rajasthan": [69.48, 23.06, 78.27, 30.2],   // Rajasthan
  "sikkim": [88.02, 27.08, 88.93, 28.13],   // Sikkim
  "tamil-nadu": [76.23, 8.08, 80.35, 13.56],   // Tamil Nadu
  "tripura": [91.15, 22.94, 92.34, 24.52],   // Tripura
  "uttar-pradesh": [77.1, 23.87, 84.64, 30.41],   // Uttar Pradesh
  "uttarakhand": [77.58, 28.71, 81.04, 31.47],   // Uttarakhand
  "west-bengal": [85.83, 21.54, 89.88, 27.22],   // West Bengal
};

function knownStates() {
  return Object.keys(STATE_BOXES);
}

// --- 2011 Census quirks -----------------------------------------------------
// The shapefile is from the 2011 Census, so a few modern states do not exist
// in it yet. These two lists let us carve them out correctly.
//   * Telangana was still part of Andhra Pradesh in 2011 (10 districts).
//   * Ladakh was still part of Jammu & Kashmir (Leh and Kargil).
const TELANGANA_2011 = [
  "Adilabad",
  "Hyderabad",
  "Karimnagar",
  "Khammam",
  "Mahbubnagar",
  "Medak",
  "Nalgonda",
  "Nizamabad",
  "Rangareddy",
  "Warangal",
];
const LADAKH_2011 = ["Leh (ladakh)", "Kargil"];

// The shapefile's ST_NM spellings differ from the modern dropdown names.
const SLUG_TO_ST_NM = {
  "andaman-and-nicobar-islands": "Andaman & Nicobar Island",
  "andhra-pradesh": "Andhra Pradesh",
  "arunachal-pradesh": "Arunanchal Pradesh",
  assam: "Assam",
  bihar: "Bihar",
  chandigarh: "Chandigarh",
  chhattisgarh: "Chhattisgarh",
  delhi: "NCT of Delhi",
  goa: "Goa",
  gujarat: "Gujarat",
  haryana: "Haryana",
  "himachal-pradesh": "Himachal Pradesh",
  "jammu-and-kashmir": "Jammu & Kashmir",
  jharkhand: "Jharkhand",
  karnataka: "Karnataka",
  kerala: "Kerala",
  lakshadweep: "Lakshadweep",
  "madhya-pradesh": "Madhya Pradesh",
  maharashtra: "Maharashtra",
  manipur: "Manipur",
  meghalaya: "Meghalaya",
  mizoram: "Mizoram",
  nagaland: "Nagaland",
  odisha: "Odisha",
  puducherry: "Puducherry",
  punjab: "Punjab",
  rajasthan: "Rajasthan",
  sikkim: "Sikkim",
  "tamil-nadu": "Tamil Nadu",
  tripura: "Tripura",
  "uttar-pradesh": "Uttar Pradesh",
  uttarakhand: "Uttarakhand",
  "west-bengal": "West Bengal",
};

// Returns the ee.Filter that selects exactly this state's districts out of the
// national asset, handling the three special cases above.
function stateFilter(stateKey) {
  if (stateKey === "ladakh") {
    return ee.Filter.inList("DISTRICT", LADAKH_2011);
  }
  if (stateKey === "jammu-and-kashmir") {
    return ee.Filter.and(
      ee.Filter.eq("ST_NM", "Jammu & Kashmir"),
      ee.Filter.inList("DISTRICT", LADAKH_2011).not(),
    );
  }
  if (stateKey === "telangana") {
    return ee.Filter.inList("DISTRICT", TELANGANA_2011);
  }
  if (stateKey === "andhra-pradesh") {
    // strip out the districts that became Telangana in 2014
    return ee.Filter.and(
      ee.Filter.eq("ST_NM", "Andhra Pradesh"),
      ee.Filter.inList("DISTRICT", TELANGANA_2011).not(),
    );
  }
  if (stateKey === "dadra-and-nagar-haveli-and-daman-and-diu") {
    // the two 2011 UTs that merged in 2020
    return ee.Filter.inList("ST_NM", ["Dadara & Nagar Havelli", "Daman & Diu"]);
  }
  const stNm = SLUG_TO_ST_NM[stateKey];
  if (!stNm) throw new Error("unknown state: " + stateKey);
  return ee.Filter.eq("ST_NM", stNm);
}

// The districts of one state, as a FeatureCollection.
function stateDistricts(stateKey) {
  return ee.FeatureCollection(INDIA_DISTRICTS_ASSET).filter(
    stateFilter(stateKey),
  );
}

// The real outline of one state, simplified to 5 km so it stays light enough
// to clip tiles with. Telangana keeps using its own official 33-district asset.
function stateOutline(stateKey) {
  if (stateKey === "telangana" && MUNI_ASSETS.telangana) {
    return ee.FeatureCollection(MUNI_ASSETS.telangana).geometry();
  }
  return stateDistricts(stateKey).geometry().simplify(5000);
}

// Geometry used by the new layers: real outline when we can, box otherwise.
function layerGeom(stateKey) {
  try {
    return stateOutline(stateKey);
  } catch (e) {
    return cityGeom(stateKey);
  }
}

// ---- palettes for the new layers ------------------------------------------
const VIS_EXTRA = {
  rainfall: {
    min: 100,
    max: 3000,
    palette: ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"],
  },
  dem: {
    min: 0,
    max: 3000,
    palette: ["#1a9850", "#fee08b", "#fdae61", "#8c510a", "#ffffff"],
  },
  slope: {
    min: 0,
    max: 45,
    palette: ["#2c7bb6", "#1a9850", "#ffffbf", "#fdae61", "#d7191c"],
  },
  water: {
    min: 0,
    max: 100,
    palette: ["#ffffff", "#ffbbbb", "#0000ff"],
  },
  // ESA WorldCover v200 official class colours, in remapped order 0..10
  lulc: {
    min: 0,
    max: 10,
    palette: [
      "#006400", // 10 tree cover
      "#ffbb22", // 20 shrubland
      "#ffff4c", // 30 grassland
      "#f096ff", // 40 cropland
      "#fa0000", // 50 built-up
      "#b4b4b4", // 60 bare / sparse
      "#f0f0f0", // 70 snow and ice
      "#0064c8", // 80 permanent water
      "#0096a0", // 90 herbaceous wetland
      "#00cf75", // 95 mangroves
      "#fae6a0", // 100 moss and lichen
    ],
  },
};

// ---- A. Rivers and streams -------------------------------------------------
// Vector layer, drawn as styled lines. Simplified to 1 km exactly as in
// Charvi's script, which keeps the render from choking at state scale.
async function riversTileUrl(stateKey) {
  const geom = layerGeom(stateKey);
  const rivers = ee
    .FeatureCollection("projects/sat-io/open-datasets/indian-streams/streams")
    .filterBounds(geom)
    .map(function (feat) {
      return feat.simplify(1000);
    });
  const styled = rivers.style({ color: "#1d6fb8", width: 1 });
  return imageToUrl(styled.clip(geom), {});
}

// ---- B. Rainfall (CHIRPS annual total) -------------------------------------
async function rainfallTileUrl(stateKey, year) {
  const geom = layerGeom(stateKey);
  const y = Number(year) || 2020;
  const img = ee
    .ImageCollection("UCSB-CHG/CHIRPS/PENTAD")
    .filterDate(y + "-01-01", y + "-12-31")
    .select("precipitation")
    .sum()
    .clip(geom);
  return imageToUrl(img, VIS_EXTRA.rainfall);
}

// ---- C. Land Use / Land Cover (ESA WorldCover v200) ------------------------
// Remapped from the raw class codes (10,20,...,100) to 0..10 so the palette
// lines up with the classes instead of being stretched across a 10-100 ramp.
async function lulcTileUrl(stateKey) {
  const geom = layerGeom(stateKey);
  const raw = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map");
  const img = raw
    .remap(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    )
    .clip(geom);
  return imageToUrl(img, VIS_EXTRA.lulc);
}

// ---- D. Elevation (NASA SRTM 30 m) -----------------------------------------
async function demTileUrl(stateKey) {
  const geom = layerGeom(stateKey);
  const dem = ee.Image("USGS/SRTMGL1_003").clip(geom);
  return imageToUrl(dem, VIS_EXTRA.dem);
}

// ---- E. Slope (derived from the DEM) ---------------------------------------
async function slopeTileUrl(stateKey) {
  const geom = layerGeom(stateKey);
  const dem = ee.Image("USGS/SRTMGL1_003");
  const slope = ee.Terrain.slope(dem).clip(geom);
  return imageToUrl(slope, VIS_EXTRA.slope);
}

// ---- F. Surface water occurrence (JRC Global Surface Water) ----------------
// NOTE: this is HISTORICAL surface-water occurrence 1984-2021, i.e. how often
// a pixel has ever been water. It is a useful flood-exposure backdrop, but it
// is NOT a flood forecast or a flood risk score - label it honestly in the UI.
async function waterOccurrenceTileUrl(stateKey) {
  const geom = layerGeom(stateKey);
  const img = ee
    .Image("JRC/GSW1_4/GlobalSurfaceWater")
    .select("occurrence")
    .clip(geom);
  return imageToUrl(img, VIS_EXTRA.water);
}