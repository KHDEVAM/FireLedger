/**
 * Watch zones: areas saved in this browser and checked against live hotspots.
 * The exported JSON is the watch/zones.json format read by the scheduled
 * refresh function (api/refresh/app.py), which can e-mail alerts through SES.
 */
import { aoiBbox, decodeAoi } from './data';
import { fetchNrt, simulatedNrt } from './nrt';
import type { Aoi } from './types';

export interface Zone {
  name: string;
  /** area encoded like the `aoi` URL parameter */
  aoi: string;
}

export type ZoneStatus = { state: 'unchecked' | 'checking' } | { state: 'ok'; count: number } | { state: 'error'; reason: string };

export const MAX_ZONES = 8;
export const ZONE_WINDOW_H = 48;
const KEY = 'fl-zones';

export function loadZones(): Zone[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Zone[];
    return raw.filter((z) => typeof z.name === 'string' && decodeAoi(z.aoi)).slice(0, MAX_ZONES);
  } catch {
    return [];
  }
}

export function saveZones(zones: Zone[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(zones.slice(0, MAX_ZONES)));
  } catch {
    /* storage can be blocked; zones then live for this visit only */
  }
}

export function zoneAoi(zone: Zone): Aoi {
  return decodeAoi(zone.aoi) ?? { kind: 'region' };
}

/** Hotspots detected inside the zone in the last 48 h. */
export async function checkZone(zone: Zone, regionBbox: [number, number, number, number], demo: boolean): Promise<number> {
  const aoi = zoneAoi(zone);
  const bbox = aoiBbox(aoi, regionBbox);
  const result = demo ? simulatedNrt(bbox) : await fetchNrt(bbox, aoi);
  return result.hotspots.filter((h) => h.ageH <= ZONE_WINDOW_H).length;
}

/** watch/zones.json for the scheduled function; the e-mail address is filled in by the operator. */
export function zonesJson(zones: Zone[], regionBbox: [number, number, number, number]): string {
  const rows = zones.map((z) => ({
    name: z.name,
    bbox: aoiBbox(zoneAoi(z), regionBbox).map((v) => +v.toFixed(4)),
    email: '',
    min_hotspots: 1,
  }));
  return JSON.stringify(rows, null, 2) + '\n';
}
