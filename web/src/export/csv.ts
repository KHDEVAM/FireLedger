import { aoiBbox, pointInAoi } from '../data';
import type { Aoi, CalendarModel } from '../types';

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const num = (v: number | null, digits = 1): string => (v === null || !Number.isFinite(v) ? '' : String(+v.toFixed(digits)));

export const MATRIX_HEADER = [
  'year', 'month', 'fire_cell_days', 'lower_band', 'upper_band', 'source', 'coverage', 'baseline_median',
  'anomaly_pct', 'robust_z', 'percentile', 'rank_among_years',
];

/** Calendar matrix + anomaly table. No-data months have empty value fields, never 0. */
export function matrixCsv(model: CalendarModel): string {
  const lines = [MATRIX_HEADER.join(',')];
  for (const row of model.cells)
    for (const c of row) {
      if (!c.inRange) continue;
      lines.push(
        [c.year, c.month, num(c.value), num(c.lo), num(c.hi), c.value === null ? '' : c.src, c.status, num(c.median), num(c.anomalyPct), num(c.z, 2), num(c.percentile, 0), c.rank ?? ''].join(','),
      );
    }
  return lines.join('\n') + '\n';
}

export const HOTSPOT_HEADER = 'latitude,longitude,acq_date,acq_time,sensor,confidence,frp,daynight,type,cell_id';

/** Keep the hotspot rows of one yearly file that fall in the AOI, the date range and the type filter. */
export function filterHotspotCsv(text: string, aoi: Aoi, bbox: [number, number, number, number], from: string, to: string, includeStatic: boolean): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');
    const lat = +f[0];
    const lon = +f[1];
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    if (f[2] < from || f[2] > to) continue;
    if (!includeStatic && f[8] !== '0') continue;
    if (!pointInAoi(lon, lat, aoi)) continue;
    out.push(line);
  }
  return out;
}

export interface HotspotExport {
  csv: string;
  rows: number;
}

/**
 * Raw hotspots for the AOI and date range, assembled in the browser from the
 * static yearly files produced by the pipeline (FIRMS data, confidence-filtered).
 */
export async function hotspotsCsv(
  regionCode: string,
  regionBbox: [number, number, number, number],
  aoi: Aoi,
  fromYm: number,
  toYm: number,
  includeStatic: boolean,
  years: number[],
  progress: (year: number) => void,
): Promise<HotspotExport> {
  const bbox = aoiBbox(aoi, regionBbox);
  const from = `${Math.floor(fromYm / 100)}-${String(fromYm % 100).padStart(2, '0')}-01`;
  const to = `${Math.floor(toYm / 100)}-${String(toYm % 100).padStart(2, '0')}-31`;
  const rows: string[] = [];
  for (const year of years) {
    if (year < Math.floor(fromYm / 100) || year > Math.floor(toYm / 100)) continue;
    progress(year);
    const res = await fetch(`${import.meta.env.BASE_URL}data/${regionCode}/hotspots/${year}.csv`);
    if (!res.ok) continue;
    rows.push(...filterHotspotCsv(await res.text(), aoi, bbox, from, to, includeStatic));
  }
  return { csv: [HOTSPOT_HEADER, ...rows].join('\n') + '\n', rows: rows.length };
}
