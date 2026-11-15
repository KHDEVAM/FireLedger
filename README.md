# FireLedger

**Two decades of fire, one consistent record.** — https://fireledger.earth

FireLedger harmonizes NASA FIRMS active-fire hotspots from MODIS (2000→) and VIIRS (2012→) into one consistent series and shows it as an interactive burning activity calendar for any area. NASA Space Apps Challenge 2026.

Current demo region: **Morocco**, Jan 2001 → 14 Nov 2026 (FIRMS yearly country files to 2025, FIRMS area API for 2026).

Live now: https://main.d2te61mh65mx1.amplifyapp.com (the custom domain is attached and waits for its DNS records).

## What is in the repository

| Folder | Content |
|---|---|
| `pipeline/` | Reproducible data pipeline: download → clean → fire-cell-days grid → MODIS↔VIIRS harmonization → aggregates → web tiles → validation figures |
| `web/` | Vite + TypeScript app: MapLibre map, area drawing, calendar heatmap, Fire Season Clock, charts, live hotspots, Response & Logistics Advisory, CSV/PNG/SVG/PDF exports, English / French / Arabic |
| `api/` | AWS Lambda handlers (Python): FIRMS NRT proxy, weather proxy, CSV export, scheduled refresh; `api/dev_server.py` runs them locally |
| `infra/template.yaml`, `infra/deploy.sh` | AWS template (Lambdas, Function URLs, S3 cache, schedule) and a deploy script that needs only the AWS CLI |
| `SOURCES.md` | Every data source, license and citation |
| `tests/`, `web/tests/` | pytest and vitest suites |

## Quick start

```bash
# pipeline (Python 3.11+)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r pipeline/requirements.txt
python pipeline/01_download.py --region MAR --years 2000-2026
python pipeline/02_clean.py && python pipeline/03_grid.py
python pipeline/04_harmonize.py && python pipeline/05_aggregate.py
python pipeline/06_export_tiles.py && python pipeline/07_validate.py
python pipeline/08_boundaries.py                        # optional: admin-1 regions

# web
cd web && npm install && npm run dev                    # http://localhost:5173  (add ?demo=1 for simulated live hotspots)

# local API (live hotspots need a free FIRMS MAP_KEY in .env, see .env.example)
python api/dev_server.py

# tests
python -m pytest -q && (cd web && npm test)
node web/scripts/e2e-flow.mjs                          # browser click-through (dev server running, Chrome installed)
python web/scripts/check_ramps.py                      # colour ramps under colour-vision deficiency

# deploy (AWS CLI logged in; MAP_KEY already in SSM, see infra/deploy.sh)
bash infra/deploy.sh all
```

## Harmonization in short

1. Detections are snapped to a common 0.01° grid; per sensor family and day each cell counts once ("fire-cell-day"), satellites are merged by union.
2. On the MODIS/VIIRS overlap (2012–2025) a per-region model (seasonal background + slope, chosen by leave-one-year-out validation) converts MODIS into VIIRS-equivalent units; 2001–Jan 2012 is backcast, later months use VIIRS directly (S-NPP, then NOAA-20 scaled to S-NPP).
3. Validation for Morocco (held-out years, monthly, whole region): R² 0.66, bias +0.6 %, MAE 24 vs 76 fire-cell-days for raw MODIS. Figures in `docs/figures/`.

## Status

Working and deployed: pipeline on real FIRMS data through mid-November 2026, calendar, anomaly view, charts, comparison of two areas, watch zones, exports, live hotspots and advisory, API on AWS Lambda, site on Amplify Hosting.

Not done yet: DNS records for fireledger.earth at Porkbun, AWS budget alert, automatic deploys from GitHub, e-mail alerts (SES), FIRMS missing-data flags. See `REPORT.md` for methods, validation and limitations.

## Acknowledgment and disclaimers

We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).

NASA does not endorse any non-U.S. Government entity and is not responsible for information contained on non-U.S. Government websites.

The advisory is decision support, not an official order. Follow instructions from your local civil protection and fire authorities. In an emergency, call your local emergency number.
