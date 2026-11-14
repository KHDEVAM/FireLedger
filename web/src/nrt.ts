import { pointInAoi } from './data';
import type { Aoi, Hotspot } from './types';

export interface NrtResult {
  hotspots: Hotspot[];
  fetchedUtc: string;
  sources: string[];
  simulated: boolean;
}

interface ApiHotspot {
  lat: number;
  lon: number;
  date: string;
  time: string;
  sat: string;
  frp: number;
  conf: string;
  dn: string;
}

function toHotspot(h: ApiHotspot, now: number): Hotspot {
  const hhmm = h.time.padStart(4, '0');
  const iso = `${h.date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
  return { lat: h.lat, lon: h.lon, time: iso, sat: h.sat, frp: h.frp, conf: h.conf, daynight: h.dn, ageH: Math.max((now - Date.parse(iso)) / 36e5, 0) };
}

/** Live hotspots of the last 7 days from the FIRMS proxy (MAP_KEY stays on the server). */
export async function fetchNrt(bbox: [number, number, number, number], aoi: Aoi, signal?: AbortSignal): Promise<NrtResult> {
  const pad = 0.05;
  const b = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad].map((v) => v.toFixed(3)).join(',');
  const res = await fetch(`/api/nrt?bbox=${b}&days=7`, { signal });
  const text = await res.text();
  let json: { error?: string; hotspots?: ApiHotspot[]; fetched_utc?: string; sources?: string[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`live feed not reachable (HTTP ${res.status})`);
  }
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  const now = Date.now();
  return {
    hotspots: (json.hotspots ?? []).map((h) => toHotspot(h, now)).filter((h) => pointInAoi(h.lon, h.lat, aoi)),
    fetchedUtc: json.fetched_utc ?? new Date().toISOString(),
    sources: json.sources ?? [],
    simulated: false,
  };
}

/**
 * Simulated detections for demonstrations and UI tests (?demo=1).
 * Never mixed with real data; the UI labels the whole panel as SIMULATED.
 */
export function simulatedNrt(bbox: [number, number, number, number]): NrtResult {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const now = Date.now();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hotspots: Hotspot[] = [];
  const add = (lon: number, lat: number, n: number, spread: number, ages: number[], frp: number) => {
    for (let i = 0; i < n; i++) {
      const ageH = ages[i % ages.length] + rnd() * 0.5;
      hotspots.push({
        lon: lon + (rnd() - 0.5) * spread,
        lat: lat + (rnd() - 0.5) * spread,
        time: new Date(now - ageH * 36e5).toISOString(),
        sat: i % 2 ? 'N20' : 'N21',
        frp: +(frp * (0.4 + rnd())).toFixed(1),
        conf: 'n',
        daynight: 'D',
        ageH,
      });
    }
  };
  add(cx, cy, 14, 0.02, [3, 4, 15, 16, 27], 45);
  add(cx + 0.08, cy - 0.05, 5, 0.012, [4, 16], 12);
  add(cx - 0.2, cy + 0.12, 2, 0.004, [30], 4);
  return { hotspots, fetchedUtc: new Date().toISOString(), sources: ['SIMULATED'], simulated: true };
}
