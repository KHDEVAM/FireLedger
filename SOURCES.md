# SOURCES — data, services and assets used by FireLedger

Every external dataset, API, tile service and bundled asset is registered here at the moment it is introduced.
Access date for all entries unless stated otherwise: **2026-11-14**.

## NASA FIRMS acknowledgment

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).

- Wording copied verbatim on 2026-11-15 from the "Acknowledgments" section of NASA's FIRMS page: https://www.earthdata.nasa.gov/data/tools/firms
- It differs from the older, widely reproduced form that ended with "part of NASA's Earth Observing System Data and Information System (EOSDIS)".
- FIRMS disclaimer ("provided as is"; users bear all responsibility for their use of the data): https://www.earthdata.nasa.gov/data/projects/lance/disclaimer
- LANCE citation page: https://www.earthdata.nasa.gov/learn/find-data/near-real-time/citation

NASA does not endorse any non-U.S. Government entity and is not responsible for information contained on non-U.S. Government websites.

---

## Official NASA sources

### NASA FIRMS — active fire hotspots (primary data source)
- Provider: NASA LANCE / FIRMS (Official NASA: **yes**)
- URL: https://firms.modaps.eosdis.nasa.gov/
- Used for: every hotspot in the app — the harmonized calendar, the density map, the raw hotspot CSV, live hotspots and the advisory.
- Access methods:
  - **Yearly country files** (history, no key): `https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<year>/<sensor>_<year>_<Country>.csv` — `pipeline/01_download.py`
  - **Area API** (live hotspots and the recent tail, MAP_KEY kept server-side): `https://firms.modaps.eosdis.nasa.gov/api/area/csv/...` — `api/common/firms.py`, `pipeline/01_download.py`
  - **Data availability API**: `https://firms.modaps.eosdis.nasa.gov/api/data_availability/` — `pipeline/01_download.py`
- License / terms: NASA open data policy; acknowledgment above.
- Required attribution text: the FIRMS acknowledgment above.

| Product | Short name | DOI | Record used |
|---|---|---|---|
| MODIS C6.1 standard (archive) active fire, Terra + Aqua | MCD14ML | `10.5067/FIRMS/MODIS/MCD14ML` | Morocco, Dec 2000 → Aug 2026 |
| MODIS C6.1 NRT active fire, Terra + Aqua | MCD14DL | `10.5067/FIRMS/MODIS/MCD14DL.NRT.0061` | Morocco, Sep → 14 Nov 2026; live hotspots |
| VIIRS 375 m, Suomi NPP | VNP14IMGT / VNP14IMGTDL_NRT | `10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002` | Morocco, 20 Jan 2012 → 31 Jul 2026, standard processing only (S-NPP ended 2 Nov 2026; its NRT feed is not used) |
| VIIRS 375 m, NOAA-20 | VJ114IMGT / VJ114IMGTDL_NRT | `10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002` | Morocco, Apr 2018 → 14 Nov 2026 (NRT from Aug 2026); live hotspots |
| VIIRS 375 m, NOAA-21 | VJ214IMGTDL_NRT | `10.5067/VIIRS/VJ214IMG_NRT.002` | Morocco, Jan → 14 Nov 2026 (standard to Jul, then NRT); live hotspots |

MODIS Collection 6.1 replaced Collection 6 (`10.5067/FIRMS/MODIS/MCD14DL.NRT.006`) in April 2021; C6.1 is cited for current data.

Algorithm papers:
- Giglio, L., Schroeder, W., & Justice, C.O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment*, 178, 31–41. doi:10.1016/j.rse.2016.02.054
- Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I.A. (2014). The New VIIRS 375 m active fire detection data product: algorithm description and initial assessment. *Remote Sensing of Environment*, 143, 85–96. doi:10.1016/j.rse.2013.12.008

Suomi NPP end of data (explains the 2 Nov 2026 change of sensors; `VIIRS_SNPP_NRT` is never used):
- Earthdata blog, "Transitioning from Suomi NPP VIIRS & OMPS: What FIRMS Users Need to Know": https://www.earthdata.nasa.gov/news/blog/transitioning-from-s-npp-viirs-omps-what-nasa-firms-users-need-know
- NOAA NESDIS notice: https://www.nesdis.noaa.gov/news/cessation-of-suomi-national-polar-orbiting-partnership-s-npp-data-users-onafter-november-2-2026

### NASA GIBS — true-color imagery
- Provider: NASA EOSDIS Global Imagery Browse Services (Official NASA: **yes**)
- URL: https://gibs.earthdata.nasa.gov/ (WMTS, EPSG:3857)
- Product / version: `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, "best", tile matrix `GoogleMapsCompatible_Level9`
- Used for: optional satellite backdrop on the map (`web/src/map/map.ts`).
- License / terms: NASA open data; acknowledge GIBS/EOSDIS.
- Required attribution text: "Imagery: NASA GIBS / EOSDIS".

---

## Non-NASA sources (used only where FIRMS/NASA cannot provide the data)

### OpenFreeMap basemap (OpenStreetMap data)
- Provider: OpenFreeMap; data © OpenStreetMap contributors (Official NASA: no)
- URL: https://openfreemap.org/ — style `https://tiles.openfreemap.org/styles/positron`
- Product / version: OpenMapTiles-schema vector tiles, Positron style
- Used for: map basemap (`web/src/map/map.ts`).
- License / terms: OpenStreetMap data under ODbL 1.0; OpenFreeMap is free to use without a key.
- Required attribution text: "© OpenStreetMap contributors" and "OpenFreeMap" (shown by the map attribution control and in the footer).
- Why needed: FIRMS provides hotspots, not a street/place basemap.

### geoBoundaries — admin-1 regions
- Provider: geoBoundaries (William & Mary geoLab) (Official NASA: no)
- URL: https://www.geoboundaries.org/ — API `https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM1/`
- Product / version: gbOpen, MAR ADM1, boundary ID `MAR-ADM1-70788906` (12 regions, year represented 2017; source "OpenStreetMap, Wambacher")
- Used for: the "Country / region" list (`pipeline/08_boundaries.py` → `web/public/data/MAR/adm1.json`, simplified outlines), and for clipping the 2026 area-API rows to the country (`pipeline/01_download.py`, `pipeline/02_clean.py`).
- License / terms: Open Data Commons Open Database License 1.0 for this boundary (OpenStreetMap-derived).
- Required attribution text: "Boundaries: geoBoundaries, © OpenStreetMap contributors (ODbL)". Citation: Runfola, D. et al. (2020) geoBoundaries: A global database of political administrative boundaries. *PLoS ONE* 15(4): e0231866. doi:10.1371/journal.pone.0231866
- Why needed: NASA FIRMS has no administrative boundaries. Boundaries are for area selection only and imply no position on any territory.

### Open-Meteo — wind, humidity, temperature
- Provider: Open-Meteo (Official NASA: no)
- URL: https://open-meteo.com/ — API `https://api.open-meteo.com/v1/forecast`
- Product / version: forecast API, current conditions + 72 h hourly
- Used for: Response & Logistics Advisory (spread direction, wind and humidity triggers), through the `/api/weather` proxy (`api/weather/app.py`).
- License / terms: CC BY 4.0; free for non-commercial use.
- Required attribution text: "Weather data by Open-Meteo.com" (CC BY 4.0).
- Why needed: FIRMS has no weather data.

### OpenStreetMap via Overpass API — settlements, hospitals, schools, water, staging candidates
- Provider: OpenStreetMap contributors; public Overpass API instances (Official NASA: no)
- URL: https://overpass-api.de/api/interpreter, with fallbacks https://overpass.private.coffee/api/interpreter and https://overpass.kumi.systems/api/interpreter (same OpenStreetMap data)
- Used for: exposure and logistics context of the advisory (`web/src/advisory/exposure.ts`). One request per advisory, only when live hotspots exist.
- License / terms: ODbL 1.0; Overpass usage policy (light use, no bulk downloads).
- Required attribution text: "© OpenStreetMap contributors".
- Why needed: FIRMS has no information on people, infrastructure or water points. Population figures are sums of OSM `population` tags and are incomplete.

### Nominatim — place search
- Provider: OpenStreetMap Foundation (Official NASA: no)
- URL: https://nominatim.openstreetmap.org/search
- Used for: "Search a place" (`web/src/main.ts`), only when the user submits a search.
- License / terms: ODbL 1.0; usage policy of at most 1 request per second.
- Required attribution text: "© OpenStreetMap contributors".
- Why needed: FIRMS has no gazetteer.

### Fonts (self-hosted)
- Montserrat (headings), Inter (body), Cairo (Arabic UI) — SIL Open Font License 1.1, bundled through the `@fontsource/*` packages (no request to Google Fonts at runtime).
- Used for: UI typography (`web/src/main.ts`, `web/src/i18n/index.ts`).

---

## Software libraries

| Library | Version | License | Used for |
|---|---|---|---|
| MapLibre GL JS | 4.x | BSD-3-Clause | map |
| D3 | 7.x | ISC | calendar and charts |
| jsPDF | 2.x | MIT | PDF briefing and advisory |
| Vite / TypeScript / Vitest | 5.x / 5.x / 2.x | MIT / Apache-2.0 / MIT | build and tests |
| pandas, NumPy, PyArrow | 2.x, 2.x, ≥16 | BSD-3 / BSD-3 / Apache-2.0 | pipeline |
| Matplotlib | 3.x | PSF-based | validation figures |
| Requests, PyYAML, Pillow, pytest | — | Apache-2.0 / MIT / HPND / MIT | downloads, config, icons, tests |

Exact versions are pinned in `web/package-lock.json`; Python minimums are in `pipeline/requirements.txt`.

## Brand assets
- `web/public/brand/logo.png`, `icon.png`: FireLedger logo, provided by the team. Derived files (favicons, PWA icons, dark-mode logo, link preview) are generated by `web/scripts/make_icons.py`.
- The NASA insignia and logotype are not used.
