# Climatium IND — Earth Engine Backend

Serves fresh Google Earth Engine tile URLs to the React frontend so the map
layers never expire. Re-implements the GEE script's index math (LST, NDVI,
NDWI, NDBI) + building footprints. The GEE script itself is NOT changed.

## 1. Setup (local)

1. Put the service-account key file in this folder, named exactly:
   `service-account.json` (it is git-ignored — NEVER commit it)
2. Copy env file: `copy .env.example .env` (Windows) / `cp .env.example .env`
3. Install: `npm install`
4. Run: `npm start`
5. You should see: `Earth Engine ready` then `API listening on http://localhost:8080`

## 2. Test it

Open in a browser:

- http://localhost:8080/api/health -> {"status":"ok","earthEngineReady":true}
- http://localhost:8080/api/tiles/ndvi?city=ahmedabad&year=2025&month=5
- http://localhost:8080/api/buildings?city=ahmedabad
  Each tile endpoint returns { "url": "https://earthengine.googleapis.com/.../{z}/{x}/{y}" }

## 3. Endpoints

- GET /api/health
- GET /api/tiles/:layer?city=&year=&month= (layer = lst | ndvi | ndwi | ndbi)
- GET /api/buildings?city=
- GET /api/hospitals (placeholder until data arrives)
- GET /api/water (placeholder)
- GET /api/population (placeholder)

## 4. Deploy (Render)

1. Push THIS folder to its own GitHub repo (service-account.json is git-ignored).
2. Render -> New Web Service -> connect the repo.
3. Build command: `npm install` Start command: `npm start`
4. Add an Environment Variable named `GEE_KEY_JSON` and paste the ENTIRE
   service-account JSON as its value (one line). Do NOT upload the file.
5. Deploy. Copy the service URL (e.g. https://climatelens-backend.onrender.com).
6. In the FRONTEND, set VITE_API_URL to that URL (see frontend .env).

## Notes

- Requires the service account to be REGISTERED for Earth Engine.
- City clipping currently uses bounding boxes; swap to municipal-boundary
  assets in ee-service.js when Prathyu shares the asset IDs.
- To add months/years: nothing to change here — any year/month works on demand.
