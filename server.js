// server.js
// Express API that serves fresh Earth Engine tile URLs to the React frontend.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const ee = require("./ee-service");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

const PORT = process.env.PORT || 8080;

// ---- simple in-memory cache so we don't recompute on every request ----
const TTL_MS = 30 * 60 * 1000; // 30 minutes for index tiles
const BUILDINGS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (footprints don't change)
const cache = new Map();
const cacheGet = (k, ttl = TTL_MS) => {
  const v = cache.get(k);
  if (v && Date.now() - v.t < ttl) return v.url;
  cache.delete(k);
  return null;
};
const cacheSet = (k, url) => cache.set(k, { url, t: Date.now() });

// ---- health check (test this first) ----
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", earthEngineReady: ee.isReady() }),
);

// ---- index tiles: /api/tiles/ndvi?city=ahmedabad&year=2025&month=5 ----
app.get("/api/tiles/:layer", async (req, res) => {
  try {
    const { layer } = req.params;
    const city = String(req.query.city || "").toLowerCase();
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!city || !year || !month)
      return res
        .status(400)
        .json({ error: "city, year and month are required" });

    const key = `tile:${city}:${year}:${month}:${layer}`;
    const hit = cacheGet(key);
    if (hit) return res.json({ url: hit, cached: true });

    const url = await ee.indexTileUrl(city, year, month, layer);
    cacheSet(key, url);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- building footprints: /api/buildings?city=ahmedabad ----
app.get("/api/buildings", async (req, res) => {
  try {
    const city = String(req.query.city || "").toLowerCase();
    if (!city) return res.status(400).json({ error: "city is required" });

    const key = `buildings:${city}`;
    const hit = cacheGet(key, BUILDINGS_TTL_MS);
    if (hit) return res.json({ url: hit, cached: true });

    const url = await ee.buildingsTileUrl(city);
    cacheSet(key, url);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- UHI hotspots: /api/uhi?city=hyderabad ----
app.get("/api/uhi", async (req, res) => {
  try {
    const city = String(req.query.city || "").toLowerCase();
    if (!city) return res.status(400).json({ error: "city is required" });
    const key = `uhi:${city}`;
    const hit = cacheGet(key, BUILDINGS_TTL_MS);
    if (hit) return res.json({ url: hit, cached: true });
    const url = await ee.uhiTileUrl(city);
    cacheSet(key, url);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- per-district stats (currently: max LST): /api/district-stats?city=telangana&year=2025&month=5 ----
app.get("/api/district-stats", async (req, res) => {
  try {
    const city = String(req.query.city || "").toLowerCase();
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!city || !year || !month)
      return res
        .status(400)
        .json({ error: "city, year and month are required" });

    const key = `district-stats:${city}:${year}:${month}`;
    const hit = cacheGet(key);
    if (hit) return res.json({ stats: hit, cached: true });

    const stats = await ee.districtMaxLST(city, year, month);
    cacheSet(key, stats);
    res.json({ stats });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- per-district building counts: /api/district-building-counts?city=telangana ----
// No year/month needed - building footprints don't change over time.
app.get("/api/district-building-counts", async (req, res) => {
  try {
    const city = String(req.query.city || "").toLowerCase();
    if (!city) return res.status(400).json({ error: "city is required" });

    const key = `district-buildings:${city}`;
    const hit = cacheGet(key, BUILDINGS_TTL_MS);
    if (hit) return res.json({ counts: hit, cached: true });

    const counts = await ee.districtBuildingCounts(city);
    cacheSet(key, counts);
    res.json({ counts });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- placeholders for datasets Prathyu is preparing ----
app.get("/api/hospitals", (_req, res) =>
  res.json({ available: false, message: "Hospitals dataset coming soon" }),
);
app.get("/api/water", (_req, res) =>
  res.json({
    available: false,
    message: "Public water facilities dataset coming soon",
  }),
);
app.get("/api/population", (_req, res) =>
  res.json({
    available: false,
    message: "Ward-wise population dataset coming soon",
  }),
);

// ---- start only after Earth Engine is authenticated ----
ee.init()
  .then(() => {
    console.log("Earth Engine ready");
    app.listen(PORT, () =>
      console.log(`API listening on http://localhost:${PORT}`),
    );
  })
  .catch((err) => {
    console.error("Earth Engine init FAILED:", err);
    process.exit(1);
  });
