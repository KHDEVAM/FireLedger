import type { CalCell, CalendarModel, Coverage, MonthValue } from './types';

export function quantile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const median = (values: number[]): number => quantile(values, 0.5);

export function mad(values: number[]): number {
  const m = median(values);
  return median(values.filter(Number.isFinite).map((v) => Math.abs(v - m)));
}

/** Median of pairwise slopes. */
export function theilSen(x: number[], y: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++)
      if (Number.isFinite(y[i]) && Number.isFinite(y[j]) && x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
  return slopes.length >= 3 ? median(slopes) : NaN;
}

function erfc(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const r = poly * Math.exp(-z * z);
  return x >= 0 ? r : 2 - r;
}

/** Two-sided Mann-Kendall p-value (normal approximation, tie-corrected). */
export function mannKendallP(values: number[]): number {
  const y = values.filter(Number.isFinite);
  const n = y.length;
  if (n < 4) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += Math.sign(y[j] - y[i]);
  const ties = new Map<number, number>();
  y.forEach((v) => ties.set(v, (ties.get(v) ?? 0) + 1));
  let tieTerm = 0;
  ties.forEach((c) => (tieTerm += c * (c - 1) * (2 * c + 5)));
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (variance <= 0) return 1;
  const z = (s - Math.sign(s)) / Math.sqrt(variance);
  return erfc(Math.abs(z) / Math.SQRT2);
}

/** Months holding more than `share` of the annual total. */
export function seasonLength(profile: number[], share = 0.1): number {
  const total = profile.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return total > 0 ? profile.filter((v) => v > share * total).length : 0;
}

export type AnomalyClass = 'below' | 'normal' | 'above' | 'extreme';

export const ANOMALY_BREAKS = { below: -40, above: 50, extreme: 200 };

export function classify(anomalyPct: number | null): AnomalyClass | null {
  if (anomalyPct === null || !Number.isFinite(anomalyPct)) return null;
  if (anomalyPct > ANOMALY_BREAKS.extreme) return 'extreme';
  if (anomalyPct > ANOMALY_BREAKS.above) return 'above';
  if (anomalyPct < ANOMALY_BREAKS.below) return 'below';
  return 'normal';
}

export interface CalendarInput {
  years: number[];
  values: Map<number, MonthValue>;
  coverage: Coverage[];
  baseline: [number, number];
  /** yyyymm from which VIIRS is observed directly */
  observedFrom: number;
  fromYm: number;
  toYm: number;
  modisOnly?: boolean;
}

/**
 * Year x month model with baselines and anomalies.
 * Months without satellite coverage stay null ("no data"), never zero.
 * The baseline median of a cell excludes the cell's own year.
 */
export function buildCalendar(input: CalendarInput): CalendarModel {
  const { years, values, baseline } = input;
  const cov = new Map(input.coverage.map((c) => [c.ym, c]));
  const cells: CalCell[][] = years.map((year) =>
    Array.from({ length: 12 }, (_, mi) => {
      const ym = year * 100 + mi + 1;
      const c = cov.get(ym);
      const status = c?.status ?? 'ok';
      const mv = values.get(ym);
      const has = status !== 'nodata';
      return {
        year,
        month: mi + 1,
        ym,
        value: has ? (mv?.v ?? 0) : null,
        lo: has ? (mv?.lo ?? 0) : null,
        hi: has ? (mv?.hi ?? 0) : null,
        status,
        note: c?.note ?? '',
        src: input.modisOnly ? 'modis_only' : ym >= input.observedFrom ? 'viirs_obs' : 'modis_est',
        inRange: ym >= input.fromYm && ym <= input.toYm,
        median: null,
        mad: null,
        anomalyPct: null,
        z: null,
        percentile: null,
        rank: null,
        nYears: 0,
      } as CalCell;
    }),
  );

  for (let mi = 0; mi < 12; mi++) {
    const column = cells.map((row) => row[mi]);
    const all = column.filter((c) => c.value !== null).map((c) => c.value as number);
    for (const cell of column) {
      if (cell.value === null) continue;
      const ref = column
        .filter((c) => c.value !== null && c.year >= baseline[0] && c.year <= baseline[1] && c.year !== cell.year)
        .map((c) => c.value as number);
      if (!ref.length) continue;
      const med = median(ref);
      const m = mad(ref);
      cell.median = med;
      cell.mad = m;
      cell.anomalyPct = ((cell.value - med) / Math.max(med, 1)) * 100;
      cell.z = m > 0 ? (cell.value - med) / (1.4826 * m) : null;
      cell.percentile = (all.filter((v) => v <= (cell.value as number)).length / all.length) * 100;
      cell.rank = all.filter((v) => v > (cell.value as number)).length + 1;
      cell.nYears = all.length;
    }
  }
  return { years, cells, baseline };
}

export interface Summary {
  annual: { year: number; total: number; complete: boolean }[];
  trendPerYear: number;
  trendP: number;
  profile: { month: number; median: number; q1: number; q3: number }[];
  peakMonth: number;
  seasonLength: number;
  top: CalCell[];
}

export function summarize(model: CalendarModel): Summary {
  const rows = model.cells.map((row) => row.filter((c) => c.inRange));
  const annual = model.years
    .map((year, i) => ({
      year,
      total: rows[i].reduce((s, c) => s + (c.value ?? 0), 0),
      complete: rows[i].length === 12 && rows[i].every((c) => c.value !== null),
      n: rows[i].length,
    }))
    .filter((a) => a.n > 0);
  const full = annual.filter((a) => a.complete);
  const profile = Array.from({ length: 12 }, (_, mi) => {
    const ref = model.cells
      .map((row) => row[mi])
      .filter((c) => c.value !== null && c.year >= model.baseline[0] && c.year <= model.baseline[1])
      .map((c) => c.value as number);
    return { month: mi + 1, median: median(ref), q1: quantile(ref, 0.25), q3: quantile(ref, 0.75) };
  });
  const med = profile.map((p) => (Number.isFinite(p.median) ? p.median : 0));
  const top = rows
    .flat()
    .filter((c) => c.value !== null && c.value > 0)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .slice(0, 10);
  return {
    annual,
    trendPerYear: theilSen(
      full.map((a) => a.year),
      full.map((a) => a.total),
    ),
    trendP: mannKendallP(full.map((a) => a.total)),
    profile,
    peakMonth: med.indexOf(Math.max(...med)) + 1,
    seasonLength: seasonLength(med),
    top,
  };
}

/** The cell the "this month vs history" panel talks about. */
export function currentCell(model: CalendarModel, today = new Date()): { cell: CalCell; isCurrentMonth: boolean } | null {
  const ym = today.getUTCFullYear() * 100 + today.getUTCMonth() + 1;
  const flat = model.cells.flat();
  const now = flat.find((c) => c.ym === ym && c.value !== null);
  if (now) return { cell: now, isCurrentMonth: true };
  const withData = flat.filter((c) => c.value !== null && c.status === 'ok');
  return withData.length ? { cell: withData[withData.length - 1], isCurrentMonth: false } : null;
}
