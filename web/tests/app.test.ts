import { describe, expect, it } from 'vitest';
import { assess, clusterHotspots, hullAreaKm2, resourcesFor, type Exposure, type Place, type Weather } from '../src/advisory/engine';
import { aggregate, decodeAoi, encodeAoi, haversineKm, parseBbox, pointInAoi, selectCells } from '../src/data';
import { filterHotspotCsv, MATRIX_HEADER, matrixCsv } from '../src/export/csv';
import ar from '../src/i18n/ar';
import en from '../src/i18n/en';
import fr from '../src/i18n/fr';
import { buildCalendar, classify, currentCell, mannKendallP, median, seasonLength, summarize, theilSen } from '../src/stats';
import type { Aoi, Hotspot, Monthly } from '../src/types';

/** 2 x 2 grid of 0.25 degree cells around (35, -5); values are easy to sum by hand. */
function fixture(): Monthly {
  const m: Monthly = { cell_size_deg: 0.25, cells: [[-5.25, 35], [-5, 35], [-5.25, 35.25], [-5, 35.25]], c: [], ym: [], h: [], lo: [], hi: [], a: [], m: [] };
  for (let year = 2001; year <= 2025; year++)
    for (let month = 1; month <= 12; month++)
      for (let cell = 0; cell < 4; cell++) {
        const v = month === 8 ? 10 + cell + (year === 2022 ? 50 : 0) : month === 1 ? 0 : 1;
        if (!v) continue;
        m.c.push(cell);
        m.ym.push(year * 100 + month);
        m.h.push(v);
        m.lo.push(year < 2012 ? v * 0.5 : v);
        m.hi.push(year < 2012 ? v * 2 : v);
        m.a.push(v + 1);
        m.m.push(v / 4);
      }
  return m;
}

const years = Array.from({ length: 25 }, (_, i) => 2001 + i);
const calendar = (values: ReturnType<typeof aggregate>, coverage = [] as { ym: number; status: 'partial' | 'nodata'; note: string }[]) =>
  buildCalendar({ years, values, coverage, baseline: [2003, 2022], observedFrom: 201202, fromYm: 200101, toYm: 202512 });

describe('area selection', () => {
  const m = fixture();
  it('selects the cells whose centre is inside the area', () => {
    expect(selectCells(m, { kind: 'region' })).toEqual([0, 1, 2, 3]);
    expect(selectCells(m, { kind: 'bbox', bbox: [-5.25, 35, -5, 35.25] })).toEqual([0]);
    expect(selectCells(m, { kind: 'bbox', bbox: [-5.3, 34.9, -4.7, 35.26] })).toEqual([0, 1]);
    expect(selectCells(m, { kind: 'poly', ring: [[-5.3, 35.2], [-4.7, 35.2], [-4.7, 35.6], [-5.3, 35.6]] })).toEqual([2, 3]);
    expect(selectCells(m, { kind: 'circle', lat: 35.125, lon: -4.875, km: 5 })).toEqual([1]);
  });
  it('gives a tiny area the cell it touches, and nothing when far away', () => {
    expect(selectCells(m, { kind: 'bbox', bbox: [-5.24, 35.01, -5.23, 35.02] })).toEqual([0]);
    expect(selectCells(m, { kind: 'bbox', bbox: [10, 10, 11, 11] })).toEqual([]);
  });
  it('round-trips the area through the URL', () => {
    for (const aoi of [{ kind: 'region' }, { kind: 'bbox', bbox: [-6, 34.8, -4.5, 35.6] }, { kind: 'circle', lat: 35.17, lon: -5.27, km: 25 }, { kind: 'poly', ring: [[-5, 35], [-4, 35], [-4.5, 36]] }] as const)
      expect(decodeAoi(encodeAoi(aoi as never))).toEqual(aoi);
    expect(decodeAoi('bbox:1,2')).toBeNull();
    expect(decodeAoi('poly:<script>')).toBeNull();
    expect(parseBbox('5,0,1,10')).toBeNull();
    expect(haversineKm(35, -5, 36, -5)).toBeCloseTo(111.2, 0);
    expect(pointInAoi(-5.1, 35.1, { kind: 'circle', lat: 35.1, lon: -5.1, km: 1 })).toBe(true);
  });
});

describe('aggregation and calendar', () => {
  const m = fixture();
  it('sums the selected cells and combines bands in quadrature', () => {
    const all = aggregate(m, [0, 1, 2, 3], 'h');
    expect(all.get(202308)!.v).toBe(10 + 11 + 12 + 13);
    expect(all.get(202308)!.lo).toBe(46);
    const est = all.get(200508)!;
    expect(est.v).toBe(46);
    expect(est.hi - est.v).toBeCloseTo(Math.sqrt(10 ** 2 + 11 ** 2 + 12 ** 2 + 13 ** 2), 6);
    expect(aggregate(m, [0], 'a').get(202308)!.v).toBe(11);
    expect(all.has(202301)).toBe(false);
  });

  it('keeps no-data months as null and observed quiet months as 0', () => {
    const model = calendar(aggregate(m, [0, 1, 2, 3], 'h'), [{ ym: 202512, status: 'nodata', note: 'outside the record' }, { ym: 200106, status: 'partial', note: 'outage' }]);
    const cell = (y: number, mo: number) => model.cells[y - 2001][mo - 1];
    expect(cell(2025, 12).value).toBeNull();
    expect(cell(2025, 12).anomalyPct).toBeNull();
    expect(cell(2024, 1).value).toBe(0);
    expect(cell(2001, 6).status).toBe('partial');
    expect(cell(2005, 8).src).toBe('modis_est');
    expect(cell(2012, 2).src).toBe('viirs_obs');
  });

  it('computes anomalies against a baseline that excludes the own year', () => {
    const model = calendar(aggregate(m, [0, 1, 2, 3], 'h'));
    const aug22 = model.cells[2022 - 2001][7];
    expect(aug22.value).toBe(246);
    expect(aug22.median).toBe(46); // 2022 itself is not in its baseline
    expect(aug22.anomalyPct).toBeCloseTo(((246 - 46) / 46) * 100, 6);
    expect(aug22.rank).toBe(1);
    expect(aug22.percentile).toBe(100);
    expect(classify(aug22.anomalyPct)).toBe('extreme');
    expect(classify(model.cells[10][7].anomalyPct)).toBe('normal');
    const s = summarize(model);
    expect(s.peakMonth).toBe(8);
    expect(s.top[0].ym).toBe(202208);
    expect(s.annual).toHaveLength(25);
    expect(s.annual.every((a) => a.complete)).toBe(true);
  });

  it('falls back to the latest month with data when the current month has none', () => {
    const model = calendar(aggregate(m, [0, 1, 2, 3], 'h'));
    const focus = currentCell(model, new Date(Date.UTC(2026, 10, 14)))!;
    expect(focus.isCurrentMonth).toBe(false);
    expect(focus.cell.ym).toBe(202512);
    expect(currentCell(model, new Date(Date.UTC(2024, 7, 2)))!.isCurrentMonth).toBe(true);
  });

  it('CSV of the calendar matches the on-screen totals', () => {
    const model = calendar(aggregate(m, [0, 1, 2, 3], 'h'), [{ ym: 202512, status: 'nodata', note: '' }]);
    const lines = matrixCsv(model).trim().split('\n');
    expect(lines[0]).toBe(MATRIX_HEADER.join(','));
    expect(lines).toHaveLength(1 + 25 * 12);
    const total = lines.slice(1).reduce((s, l) => s + (Number(l.split(',')[2]) || 0), 0);
    const screen = model.cells.flat().reduce((s, c) => s + (c.value ?? 0), 0);
    expect(total).toBeCloseTo(screen, 6);
    const noData = lines.find((l) => l.startsWith('2025,12,'))!.split(',');
    expect(noData[2]).toBe(''); // empty, never 0
    expect(noData[6]).toBe('nodata');
  });
});

describe('statistics', () => {
  it('robust trend helpers', () => {
    expect(median([3, 1, 2])).toBe(2);
    const x = years;
    expect(theilSen(x, x.map((y) => 2 * y + 1))).toBeCloseTo(2, 9);
    expect(mannKendallP(x.map((y) => y))).toBeLessThan(0.001);
    expect(mannKendallP([1, 2, 1, 2, 1, 2, 1, 2])).toBeGreaterThan(0.3);
    expect(seasonLength([0, 0, 0, 0, 0, 5, 30, 40, 20, 5, 0, 0])).toBe(3);
  });
});

describe('raw hotspot export filter', () => {
  const csv = [
    'latitude,longitude,acq_date,acq_time,sensor,confidence,frp,daynight,type,cell_id',
    '35.1,-5.1,2022-07-14,1310,VIIRS S-NPP,n,12.3,D,0,1',
    '35.1,-5.1,2022-07-14,1310,VIIRS S-NPP,n,12.3,D,2,1',
    '35.1,-5.1,2021-07-14,1310,VIIRS S-NPP,n,12.3,D,0,1',
    '36.9,-5.1,2022-07-14,1310,MODIS Aqua,80,40,D,0,2',
    '',
  ].join('\n');
  const box: [number, number, number, number] = [-6, 35, -5, 36];
  const aoi: Aoi = { kind: 'bbox', bbox: box };
  it('filters by area, date and type', () => {
    expect(filterHotspotCsv(csv, aoi, box, '2022-01-01', '2022-12-31', false)).toHaveLength(1);
    expect(filterHotspotCsv(csv, aoi, box, '2022-01-01', '2022-12-31', true)).toHaveLength(2);
    expect(filterHotspotCsv(csv, aoi, box, '2021-01-01', '2022-12-31', false)).toHaveLength(2);
    expect(filterHotspotCsv(csv, { kind: 'region' }, [-180, -90, 180, 90], '2022-01-01', '2022-12-31', false)).toHaveLength(2);
  });
});

describe('advisory engine', () => {
  const hs = (lat: number, lon: number, ageH: number, frp = 5): Hotspot => ({ lat, lon, ageH, frp, time: new Date(Date.UTC(2026, 10, 14, 12) - ageH * 36e5).toISOString(), sat: 'N20', conf: 'n', daynight: 'D' });
  const ctx = { anomalyPct: null, percentile: null, peakMonth: false, windowH: 48 };
  const town = (distKm: number, bearing: number): Place => ({ name: 'Town', kind: 'town', lat: 0, lon: 0, distKm, bearing, population: 1000, downwind: false });
  const exposure = (place: Place): Exposure => ({ settlements: [place], hospitals: [], fireStations: [], schools: [], water: [], staging: [] });
  const wind = (kmh: number, from: number, rh: number): Weather => ({ windKmh: kmh, windDirFrom: from, gustKmh: kmh * 1.5, rh, tempC: 30, maxWind72: null, minRh72: null, time: '' });

  it('tier 0 without hotspots, tier 1 for a few weak ones', () => {
    expect(assess([], null, null, ctx).tier).toBe(0);
    const a = assess([hs(35, -5, 2), hs(35.3, -5.3, 3)], null, null, ctx);
    expect(a.tier).toBe(1);
    expect(a.triggers.map((x) => x.code)).toEqual(['hotspots']);
  });

  it('tier 2 for persistence, wind or a strong anomaly - each with its reason', () => {
    expect(assess([hs(35, -5, 2), hs(35.001, -5.001, 20)], null, null, ctx).triggers.some((x) => x.code === 'persistent')).toBe(true);
    expect(assess([hs(35, -5, 2)], wind(45, 270, 50), null, ctx).tier).toBe(2);
    expect(assess([hs(35, -5, 2)], null, null, { ...ctx, anomalyPct: 250 }).triggers.some((x) => x.code === 'anomaly')).toBe(true);
  });

  it('tier 3 for intense fire or a settlement closer than 5 km', () => {
    expect(assess([hs(35, -5, 2, 150)], null, null, ctx).tier).toBe(3);
    expect(assess([hs(35, -5, 2)], null, exposure(town(3, 90)), ctx).tier).toBe(3);
    expect(assess([hs(35, -5, 2)], null, exposure(town(8, 90)), ctx).tier).toBe(1);
  });

  it('tier 4 only when dry, windy and blowing toward people', () => {
    const fire = [hs(35, -5, 2, 150)];
    // wind from the west blows toward the east (bearing 90)
    expect(assess(fire, wind(40, 270, 15), exposure(town(10, 95)), ctx).tier).toBe(4);
    expect(assess(fire, wind(40, 270, 15), exposure(town(10, 270)), ctx).tier).toBe(3); // town is upwind
    expect(assess(fire, wind(40, 270, 60), exposure(town(10, 95)), ctx).tier).toBe(3); // humid
    expect(assess(fire, wind(40, 270, 15), exposure(town(10, 95)), ctx).spreadBearing).toBe(90);
  });

  it('clusters nearby detections and scales resources', () => {
    const pts = [hs(35, -5, 1), hs(35.005, -5.005, 1), hs(35.01, -5.0, 1), hs(35.5, -5.5, 1)];
    const clusters = clusterHotspots(pts);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.points.length === 3)!.significant).toBe(true);
    expect(hullAreaKm2(pts.slice(0, 3))).toBeGreaterThan(0.1);
    const a = assess(pts, null, null, ctx);
    expect(Object.keys(resourcesFor(a))).toContain('crews');
    expect(resourcesFor(assess([], null, null, ctx))).toEqual({});
  });
});

describe('translations', () => {
  it('French and Arabic define every English key with the same placeholders', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const [name, dict] of [['fr', fr], ['ar', ar]] as const) {
      const missing = Object.keys(en).filter((k) => !(k in dict));
      expect(missing, `${name} is missing keys`).toEqual([]);
      const mismatched = Object.keys(en).filter((k) => vars(en[k]) !== vars(dict[k]));
      expect(mismatched, `${name} placeholders differ`).toEqual([]);
    }
  });
});
