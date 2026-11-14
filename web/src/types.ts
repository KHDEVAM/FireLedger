export interface Monthly {
  cell_size_deg: number;
  /** south-west corner [lon, lat] of every display cell */
  cells: [number, number][];
  c: number[];
  ym: number[];
  h: number[];
  lo: number[];
  hi: number[];
  a: number[];
  m: number[];
}

export interface Coverage {
  ym: number;
  status: 'partial' | 'nodata';
  note: string;
}

export interface Meta {
  code: string;
  name: string;
  bbox: [number, number, number, number];
  years: number[];
  data_start: string;
  data_end: string;
  baseline: [number, number];
  coverage: Coverage[];
  harmonization: {
    target_unit: string;
    viirs_observed_from: string;
    viirs_reference: Record<string, unknown>;
    overlap_years: number[];
    calibration_units: Record<string, number>;
    band: string;
    validation: {
      model: string;
      unit_month: Metrics;
      domain_month: Metrics;
      domain_month_raw_modis: Metrics;
      calendar_rank_spearman_mean: number;
    };
  };
  hotspot_rows: Record<string, number>;
  generated_utc: string;
}

export interface Metrics {
  n: number;
  r2: number;
  mae: number;
  bias_pct: number;
  spearman: number;
}

export type Aoi =
  | { kind: 'region' }
  | { kind: 'bbox'; bbox: [number, number, number, number] }
  | { kind: 'circle'; lat: number; lon: number; km: number }
  | { kind: 'poly'; ring: [number, number][]; name?: string };

export type Series = 'h' | 'a' | 'm';

export interface MonthValue {
  v: number;
  lo: number;
  hi: number;
}

export interface CalCell {
  year: number;
  month: number;
  ym: number;
  /** null = no data (never zero) */
  value: number | null;
  lo: number | null;
  hi: number | null;
  status: 'ok' | 'partial' | 'nodata';
  note: string;
  src: 'viirs_obs' | 'modis_est' | 'modis_only';
  inRange: boolean;
  median: number | null;
  mad: number | null;
  anomalyPct: number | null;
  z: number | null;
  percentile: number | null;
  /** 1 = highest value among all years for this calendar month */
  rank: number | null;
  nYears: number;
}

export interface CalendarModel {
  years: number[];
  cells: CalCell[][];
  baseline: [number, number];
}

export interface Hotspot {
  lat: number;
  lon: number;
  /** ISO UTC timestamp of the overpass */
  time: string;
  sat: string;
  frp: number;
  conf: string;
  daynight: string;
  ageH: number;
}
