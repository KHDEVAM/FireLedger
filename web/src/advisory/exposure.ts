/**
 * Exposure and logistics context around a fire cluster, from OpenStreetMap via
 * the Overpass API, and weather through the /api/weather proxy (Open-Meteo).
 * Both are non-NASA sources and are registered in SOURCES.md.
 */
import { haversineKm } from '../data';
import { advisoryConfig, bearingDeg, type Exposure, type Place, type Weather } from './engine';

/** Public Overpass instances, tried in order (they are volunteer-run and sometimes busy). */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 14000;

async function overpass(query: string, signal?: AbortSignal): Promise<{ elements: OsmElement[] }> {
  let last: unknown = new Error('Overpass not reachable');
  for (const url of OVERPASS) {
    const timer = new AbortController();
    const stop = setTimeout(() => timer.abort(), OVERPASS_TIMEOUT_MS);
    signal?.addEventListener('abort', () => timer.abort(), { once: true });
    try {
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(query)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: timer.signal });
      if (res.ok) return (await res.json()) as { elements: OsmElement[] };
      last = new Error(`Overpass HTTP ${res.status}`);
    } catch (err) {
      last = err;
      if (signal?.aborted) break;
    } finally {
      clearTimeout(stop);
    }
  }
  throw last;
}

interface OsmElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function fetchExposure(lat: number, lon: number, signal?: AbortSignal): Promise<Exposure> {
  const r = advisoryConfig.exposureRadiusM;
  const near = `(around:${r},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const mid = `(around:${Math.round(r * 0.6)},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const query = `[out:json][timeout:12];(
    node[place~"^(city|town|village|hamlet)$"]${near};
    nwr[amenity~"^(hospital|fire_station|school)$"]${mid};
    nwr[natural=water][name]${mid};
    nwr[landuse=reservoir]${mid};
    nwr[man_made~"^(water_tank|water_tower|reservoir_covered)$"]${mid};
    nwr[emergency~"^(fire_hydrant|water_tank|suction_point)$"]${mid};
    nwr[leisure~"^(pitch|stadium|sports_centre)$"]${mid};
    nwr[amenity=parking][name]${mid};
  );out center 600;`;
  const json = await overpass(query, signal);

  const out: Exposure = { settlements: [], hospitals: [], fireStations: [], schools: [], water: [], staging: [] };
  for (const el of json.elements) {
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    const tags = el.tags ?? {};
    if (pLat === undefined || pLon === undefined) continue;
    const kind = tags.place ?? tags.amenity ?? tags.emergency ?? tags.man_made ?? tags.leisure ?? tags.landuse ?? tags.natural ?? 'feature';
    const pop = tags.population ? parseInt(tags.population.replace(/\D/g, ''), 10) : NaN;
    const place: Place = {
      name: tags['name:en'] ?? tags.name ?? kind.replace(/_/g, ' '),
      kind,
      lat: pLat,
      lon: pLon,
      distKm: haversineKm(lat, lon, pLat, pLon),
      bearing: bearingDeg(lat, lon, pLat, pLon),
      population: Number.isFinite(pop) ? pop : null,
      downwind: false,
    };
    if (tags.place) out.settlements.push(place);
    else if (tags.amenity === 'hospital') out.hospitals.push(place);
    else if (tags.amenity === 'fire_station') out.fireStations.push(place);
    else if (tags.amenity === 'school') (out.schools.push(place), out.staging.push(place));
    else if (tags.leisure || tags.amenity === 'parking') out.staging.push(place);
    else out.water.push(place);
  }
  for (const list of Object.values(out) as Place[][]) list.sort((a, b) => a.distKm - b.distKm);
  return out;
}

export async function fetchWeather(lat: number, lon: number, signal?: AbortSignal): Promise<Weather> {
  const res = await fetch(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, { signal });
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return {
    windKmh: j.wind_kmh,
    windDirFrom: j.wind_dir_from,
    gustKmh: j.gust_kmh,
    rh: j.rh_pct,
    tempC: j.temp_c,
    maxWind72: j.max_wind_72h ?? null,
    minRh72: j.min_rh_72h ?? null,
    time: j.time,
  };
}
