import type { Aoi, Meta, Monthly, MonthValue, Series } from './types';

export interface Region {
  meta: Meta;
  monthly: Monthly;
}

const base = `${import.meta.env.BASE_URL}data`;

export async function loadRegion(code: string): Promise<Region> {
  const [meta, monthly] = await Promise.all([
    fetch(`${base}/${code}/meta.json`).then((r) => r.json()),
    fetch(`${base}/${code}/monthly.json`).then((r) => r.json()),
  ]);
  return { meta, monthly };
}

const KM_PER_DEG = 111.32;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(a));
}

export function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInAoi(lon: number, lat: number, aoi: Aoi): boolean {
  switch (aoi.kind) {
    case 'region':
      return true;
    case 'bbox':
      return lon >= aoi.bbox[0] && lon <= aoi.bbox[2] && lat >= aoi.bbox[1] && lat <= aoi.bbox[3];
    case 'circle':
      return haversineKm(aoi.lat, aoi.lon, lat, lon) <= aoi.km;
    case 'poly':
      return pointInRing(lon, lat, aoi.ring);
  }
}

export function aoiBbox(aoi: Aoi, regionBbox: [number, number, number, number]): [number, number, number, number] {
  switch (aoi.kind) {
    case 'region':
      return regionBbox;
    case 'bbox':
      return aoi.bbox;
    case 'circle': {
      const dLat = aoi.km / KM_PER_DEG;
      const dLon = aoi.km / (KM_PER_DEG * Math.max(Math.cos((aoi.lat * Math.PI) / 180), 0.05));
      return [aoi.lon - dLon, aoi.lat - dLat, aoi.lon + dLon, aoi.lat + dLat];
    }
    case 'poly': {
      const xs = aoi.ring.map((p) => p[0]);
      const ys = aoi.ring.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
}

/** Ring (closed) describing the AOI outline, for the map. */
export function aoiRing(aoi: Aoi, regionBbox: [number, number, number, number]): [number, number][] {
  if (aoi.kind === 'poly') return [...aoi.ring, aoi.ring[0]];
  if (aoi.kind === 'circle') {
    const ring: [number, number][] = [];
    const [w, s, e, n] = aoiBbox(aoi, regionBbox);
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * 2 * Math.PI;
      ring.push([aoi.lon + ((e - w) / 2) * Math.cos(t), aoi.lat + ((n - s) / 2) * Math.sin(t)]);
    }
    return ring;
  }
  const [w, s, e, n] = aoiBbox(aoi, regionBbox);
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}

/**
 * Display cells that belong to the AOI: cells whose centre is inside it.
 * A small AOI that contains no cell centre gets the cells its bounding box touches.
 */
export function selectCells(monthly: Monthly, aoi: Aoi): number[] {
  const size = monthly.cell_size_deg;
  if (aoi.kind === 'region') return monthly.cells.map((_, i) => i);
  const picked: number[] = [];
  monthly.cells.forEach(([lon, lat], i) => {
    if (pointInAoi(lon + size / 2, lat + size / 2, aoi)) picked.push(i);
  });
  if (picked.length) return picked;
  const [w, s, e, n] = aoiBbox(aoi, [0, 0, 0, 0]);
  monthly.cells.forEach(([lon, lat], i) => {
    if (lon < e && lon + size > w && lat < n && lat + size > s) picked.push(i);
  });
  return picked;
}

/**
 * Sum a series over the selected cells, per month.
 * The uncertainty band of the sum combines the per-cell bands in quadrature
 * (errors of different cells treated as independent - an approximation).
 */
export function aggregate(monthly: Monthly, cellIdx: number[], series: Series): Map<number, MonthValue> {
  const inSet = new Uint8Array(monthly.cells.length);
  cellIdx.forEach((i) => (inSet[i] = 1));
  const src = monthly[series];
  const acc = new Map<number, { v: number; dlo: number; dhi: number }>();
  for (let i = 0; i < monthly.c.length; i++) {
    if (!inSet[monthly.c[i]]) continue;
    const v = src[i];
    if (!v) continue;
    let a = acc.get(monthly.ym[i]);
    if (!a) acc.set(monthly.ym[i], (a = { v: 0, dlo: 0, dhi: 0 }));
    a.v += v;
    if (series === 'h') {
      a.dlo += (monthly.h[i] - monthly.lo[i]) ** 2;
      a.dhi += (monthly.hi[i] - monthly.h[i]) ** 2;
    }
  }
  const out = new Map<number, MonthValue>();
  acc.forEach((a, ym) => out.set(ym, { v: a.v, lo: Math.max(a.v - Math.sqrt(a.dlo), 0), hi: a.v + Math.sqrt(a.dhi) }));
  return out;
}

/** Per-cell totals between two months (inclusive), for the density layer. */
export function cellTotals(monthly: Monthly, series: Series, fromYm: number, toYm: number): Float64Array {
  const totals = new Float64Array(monthly.cells.length);
  const src = monthly[series];
  for (let i = 0; i < monthly.c.length; i++) {
    const ym = monthly.ym[i];
    if (ym >= fromYm && ym <= toYm) totals[monthly.c[i]] += src[i];
  }
  return totals;
}

export function aoiAreaKm2(aoi: Aoi, regionBbox: [number, number, number, number]): number {
  if (aoi.kind === 'circle') return Math.PI * aoi.km ** 2;
  const ring = aoiRing(aoi, regionBbox);
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++)
    area += ring[i][0] * kx * ring[i + 1][1] * KM_PER_DEG - ring[i + 1][0] * kx * ring[i][1] * KM_PER_DEG;
  return Math.abs(area) / 2;
}

/** AOI <-> URL parameter. */
export function encodeAoi(aoi: Aoi): string {
  const f = (v: number) => String(+v.toFixed(4));
  switch (aoi.kind) {
    case 'region':
      return 'region';
    case 'bbox':
      return `bbox:${aoi.bbox.map(f).join(',')}`;
    case 'circle':
      return `circle:${f(aoi.lat)},${f(aoi.lon)},${f(aoi.km)}`;
    case 'poly':
      return `poly:${aoi.ring.map((p) => `${f(p[0])} ${f(p[1])}`).join(';')}`;
  }
}

export function decodeAoi(text: string | null): Aoi | null {
  if (!text || text === 'region') return text ? { kind: 'region' } : null;
  const [kind, body = ''] = text.split(':');
  const nums = body.split(/[,; ]+/).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (kind === 'bbox') return parseBbox(body);
  if (kind === 'circle' && nums.length === 3 && nums[2] > 0) return { kind: 'circle', lat: nums[0], lon: nums[1], km: nums[2] };
  if (kind === 'poly' && nums.length >= 6 && nums.length % 2 === 0) {
    const ring: [number, number][] = [];
    for (let i = 0; i < nums.length; i += 2) ring.push([nums[i], nums[i + 1]]);
    return { kind: 'poly', ring };
  }
  return null;
}

export function parseBbox(text: string): Aoi | null {
  const n = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, nn] = n;
  if (w >= e || s >= nn || w < -180 || e > 180 || s < -90 || nn > 90) return null;
  return { kind: 'bbox', bbox: [w, s, e, nn] };
}
