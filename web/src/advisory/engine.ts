/**
 * Response & Logistics Advisory engine. Rule based and transparent: every tier
 * change is recorded as a trigger with the numbers that caused it.
 * Decision support only - never an official order.
 */
import { haversineKm } from '../data';
import type { Hotspot } from '../types';
import defaults from './config.json';

export type AdvisoryConfig = typeof defaults;
export const advisoryConfig: AdvisoryConfig = defaults;

export interface Cluster {
  id: number;
  points: Hotspot[];
  lat: number;
  lon: number;
  frpTotal: number;
  frpMax: number;
  areaKm2: number;
  firstSeen: string;
  lastSeen: string;
  spanH: number;
  persistent: boolean;
  significant: boolean;
}

export interface Weather {
  windKmh: number;
  /** direction the wind blows FROM, degrees */
  windDirFrom: number;
  gustKmh: number;
  rh: number;
  tempC: number;
  maxWind72: number | null;
  minRh72: number | null;
  time: string;
}

export interface Place {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  distKm: number;
  bearing: number;
  population: number | null;
  downwind: boolean;
}

export interface Exposure {
  settlements: Place[];
  hospitals: Place[];
  fireStations: Place[];
  schools: Place[];
  water: Place[];
  staging: Place[];
}

export interface Context {
  anomalyPct: number | null;
  percentile: number | null;
  /** current month is one of the historical peak burn months of the area */
  peakMonth: boolean;
  windowH: number;
}

export interface Trigger {
  tier: number;
  code: string;
  params: Record<string, string | number>;
}

export interface Assessment {
  tier: 0 | 1 | 2 | 3 | 4;
  triggers: Trigger[];
  count: number;
  frpTotal: number;
  frpMax: number;
  clusters: Cluster[];
  significantClusters: number;
  primary: Cluster | null;
  last24: number;
  prev24: number;
  /** bearing the fire is likely to spread toward (downwind), degrees */
  spreadBearing: number | null;
  nearestSettlement: Place | null;
  downwindSettlements: Place[];
  pop: { km5: number; km10: number; km25: number; tagged: number };
}

/* ---------- geometry helpers ---------- */

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function destination(lat: number, lon: number, bearing: number, km: number): [number, number] {
  const rad = Math.PI / 180;
  const d = km / 6371.0088;
  const lat2 = Math.asin(Math.sin(lat * rad) * Math.cos(d) + Math.cos(lat * rad) * Math.sin(d) * Math.cos(bearing * rad));
  const lon2 = lon * rad + Math.atan2(Math.sin(bearing * rad) * Math.sin(d) * Math.cos(lat * rad), Math.cos(d) - Math.sin(lat * rad) * Math.sin(lat2));
  return [lon2 / rad, lat2 / rad];
}

/** Convex hull area in km2 (0 for fewer than 3 points). */
export function hullAreaKm2(points: { lat: number; lon: number }[]): number {
  if (points.length < 3) return 0;
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const pts = points.map((p) => [p.lon * kx, p.lat * 111.32] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** Density clustering with minPts = 1 (connected components within eps). */
export function clusterHotspots(hotspots: Hotspot[], cfg: AdvisoryConfig = advisoryConfig): Cluster[] {
  const n = hotspots.length;
  const label = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] !== -1) continue;
    label[i] = next;
    const stack = [i];
    while (stack.length) {
      const a = stack.pop()!;
      for (let b = 0; b < n; b++) {
        if (label[b] !== -1) continue;
        if (Math.abs(hotspots[a].lat - hotspots[b].lat) > 0.05) continue;
        if (haversineKm(hotspots[a].lat, hotspots[a].lon, hotspots[b].lat, hotspots[b].lon) <= cfg.clusterEpsKm) {
          label[b] = next;
          stack.push(b);
        }
      }
    }
    next++;
  }
  const clusters: Cluster[] = [];
  for (let id = 0; id < next; id++) {
    const points = hotspots.filter((_, i) => label[i] === id);
    const times = points.map((p) => Date.parse(p.time)).sort((a, b) => a - b);
    const frp = points.map((p) => (Number.isFinite(p.frp) ? p.frp : 0));
    const spanH = (times[times.length - 1] - times[0]) / 36e5;
    clusters.push({
      id,
      points,
      lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
      lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
      frpTotal: frp.reduce((a, b) => a + b, 0),
      frpMax: Math.max(...frp),
      areaKm2: hullAreaKm2(points),
      firstSeen: new Date(times[0]).toISOString(),
      lastSeen: new Date(times[times.length - 1]).toISOString(),
      spanH,
      persistent: spanH >= cfg.persistHours,
      significant: points.length >= cfg.clusterMinPoints,
    });
  }
  return clusters.sort((a, b) => b.frpTotal - a.frpTotal || b.points.length - a.points.length);
}

export function markDownwind(places: Place[], weather: Weather | null, cfg: AdvisoryConfig = advisoryConfig): Place[] {
  if (!weather) return places;
  const to = (weather.windDirFrom + 180) % 360;
  return places.map((p) => ({ ...p, downwind: p.distKm <= cfg.downwindRangeKm && angleDiff(p.bearing, to) <= cfg.downwindConeDeg }));
}

export function assess(
  hotspots: Hotspot[],
  weather: Weather | null,
  exposure: Exposure | null,
  ctx: Context,
  cfg: AdvisoryConfig = advisoryConfig,
): Assessment {
  const clusters = clusterHotspots(hotspots, cfg);
  const primary = clusters[0] ?? null;
  const count = hotspots.length;
  const frpTotal = clusters.reduce((s, c) => s + c.frpTotal, 0);
  const frpMax = clusters.reduce((s, c) => Math.max(s, c.frpMax), 0);
  const significant = clusters.filter((c) => c.significant).length;
  const last24 = hotspots.filter((h) => h.ageH <= 24).length;
  const prev24 = hotspots.filter((h) => h.ageH > 24 && h.ageH <= 48).length;
  const settlements = exposure ? markDownwind(exposure.settlements, weather, cfg) : [];
  const nearest = settlements.length ? settlements.reduce((a, b) => (a.distKm <= b.distKm ? a : b)) : null;
  const downwind = settlements.filter((s) => s.downwind);
  const popWithin = (km: number) => settlements.filter((s) => s.distKm <= km).reduce((sum, s) => sum + (s.population ?? 0), 0);

  const triggers: Trigger[] = [];
  let tier = 0;
  const raise = (to: number, code: string, params: Trigger['params'] = {}) => {
    triggers.push({ tier: to, code, params });
    tier = Math.max(tier, to);
  };

  if (count > 0) {
    raise(1, 'hotspots', { count, hours: ctx.windowH });
    if (count > cfg.tier1MaxHotspots) raise(2, 'many', { count, limit: cfg.tier1MaxHotspots });
    const persistent = clusters.filter((c) => c.persistent);
    if (persistent.length) raise(2, 'persistent', { n: persistent.length, hours: Math.round(Math.max(...persistent.map((c) => c.spanH))) });
    if (ctx.anomalyPct !== null && ctx.anomalyPct > cfg.anomalyHighPct) raise(2, 'anomaly', { pct: Math.round(ctx.anomalyPct), limit: cfg.anomalyHighPct });
    if (weather && weather.windKmh > cfg.windStrongKmh) raise(2, 'wind', { kmh: Math.round(weather.windKmh), limit: cfg.windStrongKmh });
    if (frpMax >= cfg.frpHighMw) raise(3, 'frpmax', { mw: Math.round(frpMax), limit: cfg.frpHighMw });
    if (frpTotal >= cfg.frpTotalHighMw) raise(3, 'frptotal', { mw: Math.round(frpTotal), limit: cfg.frpTotalHighMw });
    if (significant >= cfg.multiClusterCount) raise(3, 'multicluster', { n: significant, limit: cfg.multiClusterCount });
    if (nearest && nearest.distKm < cfg.settlementNearKm) raise(3, 'settlement', { name: nearest.name, km: nearest.distKm.toFixed(1), limit: cfg.settlementNearKm });
    if (tier >= 3 && weather && weather.rh < cfg.rhLowPct && weather.windKmh >= cfg.windStrongKmh && downwind.length)
      raise(4, 'emergency', { rh: Math.round(weather.rh), kmh: Math.round(weather.windKmh), name: downwind[0].name });
  }

  return {
    tier: tier as Assessment['tier'],
    triggers,
    count,
    frpTotal,
    frpMax,
    clusters,
    significantClusters: significant,
    primary,
    last24,
    prev24,
    spreadBearing: weather ? (weather.windDirFrom + 180) % 360 : null,
    nearestSettlement: nearest,
    downwindSettlements: downwind,
    pop: { km5: popWithin(5), km10: popWithin(10), km25: popWithin(25), tagged: settlements.filter((s) => s.population !== null).length },
  };
}

/** Resource ranges for a tier, scaled by the number of significant clusters (at least 1, at most 4). */
export function resourcesFor(a: Assessment, cfg: AdvisoryConfig = advisoryConfig): Record<string, [number, number]> {
  if (a.tier === 0) return {};
  const base = cfg.resources[String(a.tier) as '1' | '2' | '3' | '4'] as Record<string, number[]>;
  const k = Math.min(Math.max(a.significantClusters, 1), 4);
  return Object.fromEntries(Object.entries(base).map(([key, [lo, hi]]) => [key, [lo * k, hi * k] as [number, number]]));
}

/** Staging candidates: 3-10 km from the fire and not on the downwind side. */
export function stagingSites(exposure: Exposure, weather: Weather | null, cfg: AdvisoryConfig = advisoryConfig): Place[] {
  const to = weather ? (weather.windDirFrom + 180) % 360 : null;
  return exposure.staging
    .filter((p) => p.distKm >= cfg.stagingMinKm && p.distKm <= cfg.stagingMaxKm)
    .filter((p) => to === null || angleDiff(p.bearing, to) > 90)
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 4);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number): string => COMPASS[Math.round(deg / 45) % 8];
