import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import './styles/tokens.css';
import './styles/app.css';

import { advisoryConfig, assess, destination, type Exposure, type Weather } from './advisory/engine';
import { fetchExposure, fetchWeather } from './advisory/exposure';
import { buildAdvisory, renderAdvisory, type AdvisoryDoc } from './advisory/panel';
import { renderClock } from './calendar/clock';
import { renderCalendarTable, renderHeatmap, renderLegend, signed, type ColorMode } from './calendar/heatmap';
import { annualTable, renderAnnual, renderBox, renderSeason, renderTop, seasonTable, topTable } from './charts/charts';
import { ageColors, countScale, rampColors, zeroColor } from './colors';
import { aggregate, aoiAreaKm2, aoiBbox, aoiRing, cellTotals, decodeAoi, encodeAoi, loadRegion, parseBbox, selectCells, type Region } from './data';
import { downloadBlob, hotspotsCsv, matrixCsv } from './export/csv';
import { downloadPng, downloadSvg, svgToCanvas } from './export/image';
import { fmt, getLang, isLang, monthName, setLang, t, type Lang } from './i18n';
import { FireMap } from './map/map';
import { fetchNrt, simulatedNrt, type NrtResult } from './nrt';
import { buildCalendar, classify, currentCell, summarize, type Summary } from './stats';
import type { Aoi, CalCell, CalendarModel, Series } from './types';
import { $, escapeHtml, setStatus } from './ui';

const REGION = 'MAR';
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';

interface AdminArea {
  name: string;
  ring: [number, number][];
}

const state = {
  aoi: { kind: 'region' } as Aoi,
  fromYm: 0,
  toYm: 0,
  mode: 'count' as ColorMode,
  view: 'grid' as 'grid' | 'clock' | 'table',
  includeStatic: false,
  modisOnly: false,
  windowH: 48,
};

let region: Region;
let map: FireMap;
/** The basemap needs the network; analytics must work even if it never loads. */
let mapReady = false;
let admin: AdminArea[] = [];
let model: CalendarModel;
let summary: Summary;
let focus: { cell: CalCell; isCurrentMonth: boolean } | null = null;
let nrt: NrtResult | null = null;
let nrtError = '';
let nrtAbort: AbortController | null = null;
let context: { key: string; weather: Weather | null; exposure: Exposure | null } | null = null;
let advisory: AdvisoryDoc | null = null;
let timelapse: number | null = null;

const ymText = (ym: number) => `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}`;
const ymParse = (text: string | null): number | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(text ?? '');
  return m ? +m[1] * 100 + +m[2] : null;
};
const series = (): Series => (state.modisOnly ? 'm' : state.includeStatic ? 'a' : 'h');

function aoiName(): string {
  const a = state.aoi;
  const f = (v: number) => v.toFixed(2);
  if (a.kind === 'region') return t('aoi.name.region', { name: region.meta.name });
  if (a.kind === 'bbox') return t('aoi.name.bbox', { w: f(a.bbox[0]), s: f(a.bbox[1]), e: f(a.bbox[2]), n: f(a.bbox[3]) });
  if (a.kind === 'circle') return t('aoi.name.circle', { km: fmt(a.km), lat: f(a.lat), lon: f(a.lon) });
  return a.name ?? t('aoi.name.poly', { n: a.ring.length });
}

/* ------------------------------------------------------------------ analytics */

function recompute(): void {
  const cells = selectCells(region.monthly, state.aoi);
  const values = aggregate(region.monthly, cells, series());
  const [y, m] = region.meta.harmonization.viirs_observed_from.split('-').map(Number);
  model = buildCalendar({
    years: region.meta.years,
    values,
    coverage: region.meta.coverage,
    baseline: region.meta.baseline,
    observedFrom: y * 100 + m,
    fromYm: state.fromYm,
    toYm: state.toYm,
    modisOnly: state.modisOnly,
  });
  summary = summarize(model);
  focus = currentCell(model);
  // for the whole country the area is the sum of the grid cells that hold fire records
  const size = region.monthly.cell_size_deg;
  const cellKm2 = (i: number) => 111.32 ** 2 * size * size * Math.cos(((region.monthly.cells[i][1] + size / 2) * Math.PI) / 180);
  const area = state.aoi.kind === 'region' ? cells.reduce((sum, i) => sum + cellKm2(i), 0) : aoiAreaKm2(state.aoi, region.meta.bbox);
  $('aoi-summary').textContent = cells.length
    ? t('aoi.summary', { name: aoiName(), area: fmt(Math.round(area)), cells: cells.length })
    : t('aoi.empty');
}

function renderNow(): void {
  if (!focus) return;
  const { cell, isCurrentMonth } = focus;
  const month = monthName(cell.month, 'long');
  $('now-month').textContent = t(isCurrentMonth ? 'now.current' : 'now.latest', { month, year: cell.year, end: region.meta.data_end });
  $('now-value').textContent = fmt(cell.value ?? 0);
  $('now-median').textContent = cell.median === null ? '–' : fmt(cell.median);
  $('now-anomaly').textContent = cell.anomalyPct === null ? '–' : `${signed(cell.anomalyPct)} %`;
  $('now-pct').textContent = cell.percentile === null ? '–' : String(Math.round(cell.percentile));
  $('now-rank').textContent = cell.rank === null ? '–' : t('now.rankfmt', { rank: cell.rank, n: cell.nYears });
  const cls = classify(cell.anomalyPct);
  const badge = $('now-badge');
  badge.className = `badge ${cls ?? ''}`;
  // never color alone: icon + label
  badge.textContent = cls ? `${{ below: '▼', normal: '●', above: '▲', extreme: '▲▲' }[cls]} ${t(`class.${cls}`)}` : '';
  renderBox($('now-box'), model, cell);
  $('normal-sentence').textContent = sentence(cell);
}

/** "Is this normal?" in one plain sentence. */
function sentence(cell: CalCell): string {
  if (cell.value === null || cell.median === null) return '';
  const base = { month: monthName(cell.month, 'long'), year: cell.year, b0: model.baseline[0], b1: model.baseline[1] };
  const above = (cell.rank ?? 1) - 1;
  const higher = above === 0 ? t('sent.higher0') : above === 1 ? t('sent.higher1') : above <= 5 ? t('sent.highern', { n: above }) : t('sent.highermany', { n: above });
  if (cell.value === 0 && cell.median === 0) return t('sent.quiet', base);
  if (cell.median === 0) return t('sent.unusual', { ...base, value: fmt(cell.value), higher });
  const cls = classify(cell.anomalyPct);
  if (cls === 'above' || cls === 'extreme') return t('sent.above', { ...base, x: (cell.value / cell.median).toFixed(1), higher });
  if (cls === 'below') return t('sent.below', { ...base, pct: Math.round(-(cell.anomalyPct ?? 0)) });
  return t('sent.normal', { ...base, median: fmt(cell.median) });
}

function renderCalendar(): void {
  const el = $('calendar');
  const opts = { mode: state.mode, currentYm: focus?.cell.ym ?? null };
  if (state.view === 'grid') renderHeatmap(el, model, opts);
  else if (state.view === 'clock') renderClock(el, model, opts);
  else renderCalendarTable(el, model, state.mode);
  renderLegend($('cal-legend'), model, state.mode);
}

function renderCharts(): void {
  renderAnnual($('chart-annual'), summary);
  const year = focus?.cell.year ?? model.years[model.years.length - 1];
  const row = model.cells[model.years.indexOf(year)];
  renderSeason($('chart-season'), summary, row, year, model.baseline);
  renderTop($('chart-top'), summary);
  const s = summary.trendPerYear;
  $('chart-annual-alt').textContent = Number.isFinite(s)
    ? `${t(s >= 0 ? 'charts.trend.up' : 'charts.trend.down', { slope: fmt(Math.abs(s)), p: summary.trendP.toFixed(2) })} ${t(summary.trendP < 0.05 ? 'charts.trend.sig' : 'charts.trend.nosig')}`
    : t('charts.trend.none');
  $('chart-season-alt').textContent = t('charts.seasonalt', { peak: monthName(summary.peakMonth, 'long'), len: summary.seasonLength });
  $('table-annual').innerHTML = annualTable(summary);
  $('table-season').innerHTML = seasonTable(summary, row, year);
  $('table-top').innerHTML = topTable(summary);
}

function renderMapData(singleYm: number | null = null): void {
  if (!mapReady) return;
  const m = region.monthly;
  const totals = singleYm ? cellTotals(m, series(), singleYm, singleYm) : cellTotals(m, series(), state.fromYm, state.toYm);
  // the time-lapse keeps one scale for all months so frames are comparable
  const scale = singleYm ? countScale(Array.from(m[series()])) : countScale(Array.from(totals));
  map.setDensity(m.cells, m.cell_size_deg, totals, scale.color);
  map.setAoi(state.aoi.kind === 'region' ? null : aoiRing(state.aoi, region.meta.bbox));
  const colors = rampColors();
  const sw = (c: string, label: string, dot = false) => `<span><span class="sw${dot ? ' dot' : ''}" style="background:${c}"></span>${label}</span>`;
  const edges = [0, ...scale.breaks];
  const density = edges.map((lo, k) => {
    const idx = scale.breaks.length ? Math.round((k / scale.breaks.length) * (colors.length - 1)) : 2;
    return sw(colors[idx], k === edges.length - 1 ? `≥ ${fmt(Math.max(lo, 1))}` : `${fmt(Math.max(lo, 1))}–${fmt(scale.breaks[k])}`);
  });
  const ages = ageColors();
  $('map-legend').innerHTML =
    `<span><strong>${t('map.legend.density')}</strong> (${singleYm ? ymText(singleYm) : t('map.legend.range')})</span>${sw(zeroColor(), '0')}${density.join('')}` +
    `<span><strong>${t('map.legend.age')}</strong></span>${sw(ages[0], '< 6 h', true)}${sw(ages[1], '6–24 h', true)}${sw(ages[2], '24–48 h', true)}${sw(ages[3], '> 48 h', true)}` +
    `<span>${t('map.legend.wind')}</span>`;
}

function renderMethods(): void {
  const meta = region.meta;
  const v = meta.harmonization.validation;
  const o = meta.harmonization.overlap_years;
  const vars = {
    o0: o[0], o1: o[o.length - 1], y0: meta.years[0], b0: meta.baseline[0], b1: meta.baseline[1], start: meta.data_start, end: meta.data_end,
    r2: v.domain_month.r2.toFixed(2), bias: signed(+v.domain_month.bias_pct.toFixed(1)), mae: fmt(Math.round(v.domain_month.mae)),
    mae0: fmt(Math.round(v.domain_month_raw_modis.mae)), rank: v.calendar_rank_spearman_mean.toFixed(2),
  };
  const base = import.meta.env.BASE_URL;
  $('methods-body').innerHTML =
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((k) => `<p>${escapeHtml(t(`methods.${k}`, vars))}</p>`).join('') +
    `<figure><img src="${base}data/${meta.code}/validation.png" alt="${escapeHtml(t('methods.fig'))}" loading="lazy" width="1800" height="630" /><figcaption class="hint">${escapeHtml(t('methods.fig'))}</figcaption></figure>` +
    `<figure><img src="${base}data/${meta.code}/before_after.png" alt="" loading="lazy" width="1800" height="630" /></figure>` +
    `<p><a href="${base}SOURCES.md">${escapeHtml(t('methods.sources'))}</a></p>`;
  $('footer-attrib').textContent = t('footer.attrib');
}

function syncUrl(): void {
  const q = new URLSearchParams();
  q.set('aoi', encodeAoi(state.aoi));
  q.set('from', ymText(state.fromYm));
  q.set('to', ymText(state.toYm));
  q.set('lang', getLang());
  if (demo) q.set('demo', '1');
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
}

/** Recompute and redraw everything that depends on the AOI, range or series. */
function update(): void {
  recompute();
  renderNow();
  renderCalendar();
  renderCharts();
  renderMapData();
  renderLive();
  syncUrl();
}

/* ------------------------------------------------------------------ live + advisory */

async function loadLive(): Promise<void> {
  nrtAbort?.abort();
  nrtAbort = new AbortController();
  const bbox = aoiBbox(state.aoi, region.meta.bbox);
  nrt = null;
  nrtError = '';
  context = null;
  setStatus('live-status', t('live.loading'));
  $('advisory').innerHTML = '';
  try {
    nrt = demo ? simulatedNrt(bbox) : await fetchNrt(bbox, state.aoi, nrtAbort.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    nrtError = (err as Error).message;
  }
  renderLive();
}

function renderLive(): void {
  if (!nrt) {
    if (mapReady) {
      map.setNrt([]);
      map.setWind(null);
    }
    advisory = null;
    if (nrtError) setStatus('live-status', t('live.error', { reason: nrtError }), 'warn');
    return;
  }
  const inWindow = nrt.hotspots.filter((h) => h.ageH <= state.windowH);
  if (mapReady) map.setNrt(nrt.hotspots.filter((h) => h.ageH <= Math.max(state.windowH, 48)));
  const time = nrt.fetchedUtc.slice(0, 16).replace('T', ' ');
  setStatus('live-status', t(inWindow.length ? 'live.count' : 'live.none', { count: inWindow.length, hours: state.windowH, time }), inWindow.length ? 'warn' : 'info');

  const peak = [...summary.profile].sort((a, b) => (b.median || 0) - (a.median || 0)).slice(0, summary.seasonLength || 1).map((p) => p.month);
  const ctx = {
    anomalyPct: focus?.isCurrentMonth ? focus.cell.anomalyPct : null,
    percentile: focus?.isCurrentMonth ? focus.cell.percentile : null,
    peakMonth: peak.includes(new Date().getUTCMonth() + 1),
    windowH: state.windowH,
  };
  const first = assess(inWindow, null, null, ctx);
  const key = first.primary ? `${first.primary.lat.toFixed(2)},${first.primary.lon.toFixed(2)}` : '';
  const ready = context && context.key === key ? context : null;
  const a = assess(inWindow, ready?.weather ?? null, ready?.exposure ?? null, ctx);
  advisory = buildAdvisory({
    assessment: a,
    weather: ready?.weather ?? null,
    exposure: ready?.exposure ?? null,
    ctx,
    regionCode: region.meta.code,
    areaName: aoiName(),
    postFire: inWindow.length === 0 && nrt.hotspots.length > 0,
    simulated: nrt.simulated,
  });
  renderAdvisory($('advisory'), advisory);
  if (!mapReady) {
    /* wind vector is drawn once the map is ready */
  } else if (a.primary && a.spreadBearing !== null && ready?.weather) {
    const len = Math.min(Math.max(ready.weather.windKmh / 2, 5), advisoryConfig.downwindRangeKm);
    map.setWind([[a.primary.lon, a.primary.lat], destination(a.primary.lat, a.primary.lon, a.spreadBearing, len)]);
  } else map.setWind(null);

  if (first.primary && !ready) void loadContext(key, first.primary.lat, first.primary.lon);
}

/** Wind/humidity and nearby places for the main fire group; the advisory re-renders when they arrive. */
async function loadContext(key: string, lat: number, lon: number): Promise<void> {
  context = { key, weather: null, exposure: null };
  const mine = context;
  const status = document.getElementById('adv-status');
  if (status) status.textContent = t('live.context');
  const [w, x] = await Promise.allSettled([fetchWeather(lat, lon), fetchExposure(lat, lon)]);
  if (context !== mine) return;
  mine.weather = w.status === 'fulfilled' ? w.value : null;
  mine.exposure = x.status === 'fulfilled' ? x.value : null;
  renderLive();
}

/* ------------------------------------------------------------------ area selection */

function setAoi(aoi: Aoi, fit = true): void {
  state.aoi = aoi;
  stopTimelapse();
  update();
  if (fit && mapReady) map.fit(aoiBbox(aoi, region.meta.bbox));
  void loadLive();
}

function setupArea(): void {
  const hint = $('draw-hint');
  const drawButtons = { rect: $('draw-rect'), poly: $('draw-poly') };
  const reset = () => Object.values(drawButtons).forEach((b) => b.setAttribute('aria-pressed', 'false'));
  (['rect', 'poly'] as const).forEach((mode) => {
    drawButtons[mode].addEventListener('click', () => {
      reset();
      drawButtons[mode].setAttribute('aria-pressed', 'true');
      hint.textContent = t(`draw.hint.${mode}`);
      map.startDraw(
        mode,
        (ring) => {
          reset();
          hint.textContent = '';
          if (mode === 'rect') setAoi({ kind: 'bbox', bbox: [ring[0][0], ring[0][1], ring[2][0], ring[2][1]] }, false);
          else setAoi({ kind: 'poly', ring }, false);
        },
        () => {
          reset();
          hint.textContent = t('draw.cancelled');
        },
      );
    });
  });
  $('draw-clear').addEventListener('click', () => {
    ($('admin') as HTMLSelectElement).value = '';
    setAoi({ kind: 'region' });
  });

  $('circle-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const val = (id: string) => parseFloat(($(id) as HTMLInputElement).value.replace(',', '.'));
    const [lat, lon, km] = [val('c-lat'), val('c-lon'), val('c-km')];
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(km > 0 && km <= 500)) return void (hint.textContent = t('area.invalid'));
    hint.textContent = '';
    setAoi({ kind: 'circle', lat, lon, km });
  });
  $('bbox-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const aoi = parseBbox(($('bbox') as HTMLInputElement).value);
    if (!aoi) return void (hint.textContent = t('area.invalid'));
    hint.textContent = '';
    setAoi(aoi);
  });

  $('admin').addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    const area = admin.find((a) => a.name === value);
    setAoi(area ? { kind: 'poly', ring: area.ring, name: area.name } : { kind: 'region' });
  });

  // place search: OpenStreetMap Nominatim, only on submit (max 1 request per second by policy)
  $('place-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = ($('place') as HTMLInputElement).value.trim();
    const list = $('place-results');
    if (!q) return;
    list.innerHTML = `<li class="hint">${escapeHtml(t('place.searching'))}</li>`;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=${getLang()}&q=${encodeURIComponent(q)}`;
      const results = (await (await fetch(url)).json()) as { display_name: string; lat: string; lon: string; boundingbox: string[] }[];
      list.innerHTML = results.length ? '' : `<li class="hint">${escapeHtml(t('place.none'))}</li>`;
      results.forEach((r) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = r.display_name;
        btn.addEventListener('click', () => {
          const [s, n, w, e] = r.boundingbox.map(Number);
          list.innerHTML = '';
          // very small results (a point of interest) become a 10 km circle
          if (e - w < 0.05 || n - s < 0.05) setAoi({ kind: 'circle', lat: +r.lat, lon: +r.lon, km: 10 });
          else setAoi({ kind: 'bbox', bbox: [w, s, e, n] });
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    } catch {
      list.innerHTML = `<li class="hint">${escapeHtml(t('place.error'))}</li>`;
    }
  });
}

function fillAdmin(): void {
  const select = $('admin') as HTMLSelectElement;
  const current = state.aoi.kind === 'poly' ? state.aoi.name ?? '' : '';
  select.innerHTML = '';
  select.add(new Option(t('area.whole', { name: region.meta.name }), ''));
  admin.forEach((a) => select.add(new Option(a.name, a.name)));
  select.value = current;
}

/* ------------------------------------------------------------------ controls */

function setupRange(): void {
  const from = $('from') as HTMLInputElement;
  const to = $('to') as HTMLInputElement;
  const first = region.meta.years[0] * 100 + 1;
  const last = +region.meta.data_end.slice(0, 4) * 100 + +region.meta.data_end.slice(5, 7);
  from.min = to.min = ymText(first);
  from.max = to.max = ymText(last);
  const apply = () => {
    const a = ymParse(from.value) ?? first;
    const b = ymParse(to.value) ?? last;
    state.fromYm = Math.max(Math.min(a, b), first);
    state.toYm = Math.min(Math.max(a, b), last);
    stopTimelapse();
    update();
  };
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);
  $('range-all').addEventListener('click', () => {
    from.value = ymText(first);
    to.value = ymText(last);
    apply();
  });
  state.fromYm = Math.max(ymParse(params.get('from')) ?? first, first);
  state.toYm = Math.min(ymParse(params.get('to')) ?? last, last);
  if (state.fromYm > state.toYm) [state.fromYm, state.toYm] = [first, last];
  from.value = ymText(state.fromYm);
  to.value = ymText(state.toYm);
}

function monthsInRange(): number[] {
  const out: number[] = [];
  for (let ym = state.fromYm; ym <= state.toYm; ym = ym % 100 === 12 ? ym + 89 : ym + 1) out.push(ym);
  return out;
}

function stopTimelapse(): void {
  if (timelapse !== null) clearInterval(timelapse);
  timelapse = null;
  const btn = document.getElementById('tl-play');
  if (!btn) return;
  btn.setAttribute('aria-pressed', 'false');
  btn.textContent = t('map.play');
  ($('tl-slider') as HTMLInputElement).disabled = true;
  $('tl-label').textContent = '';
}

function setupControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((el) =>
    el.addEventListener('change', () => ((state.mode = el.value as ColorMode), renderCalendar())),
  );
  document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((el) =>
    el.addEventListener('change', () => ((state.view = el.value as typeof state.view), renderCalendar())),
  );
  document.querySelectorAll<HTMLInputElement>('input[name="window"]').forEach((el) =>
    el.addEventListener('change', () => ((state.windowH = +el.value), renderLive())),
  );
  const stat = $('static') as HTMLInputElement;
  const modis = $('modis-only') as HTMLInputElement;
  stat.addEventListener('change', () => ((state.includeStatic = stat.checked), update()));
  modis.addEventListener('change', () => ((state.modisOnly = modis.checked), (stat.disabled = modis.checked), update()));

  (['density', 'nrt', 'gibs'] as const).forEach((layer) => {
    const box = $(`layer-${layer}`) as HTMLInputElement;
    box.addEventListener('change', () => {
      map.setVisible(layer, box.checked);
      if (layer === 'nrt') map.map.setLayoutProperty('wind', 'visibility', box.checked ? 'visible' : 'none');
    });
  });

  // time-lapse of the monthly harmonized density
  const slider = $('tl-slider') as HTMLInputElement;
  const show = (i: number) => {
    const months = monthsInRange();
    const ym = months[Math.min(i, months.length - 1)];
    slider.value = String(i);
    $('tl-label').textContent = `${monthName(ym % 100, 'short')} ${Math.floor(ym / 100)}`;
    renderMapData(ym);
  };
  slider.addEventListener('input', () => show(+slider.value));
  $('tl-play').addEventListener('click', () => {
    if (timelapse !== null) {
      stopTimelapse();
      return renderMapData();
    }
    const months = monthsInRange();
    slider.max = String(months.length - 1);
    slider.disabled = false;
    $('tl-play').setAttribute('aria-pressed', 'true');
    $('tl-play').textContent = t('map.pause');
    let i = 0;
    show(0);
    timelapse = window.setInterval(() => show((i = (i + 1) % months.length)), 280);
  });

  document.querySelectorAll<HTMLButtonElement>('[data-table]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wrap = $(`table-${btn.dataset.table}`);
      wrap.hidden = !wrap.hidden;
      btn.setAttribute('aria-expanded', String(!wrap.hidden));
    }),
  );

  const langSel = $('lang') as HTMLSelectElement;
  langSel.addEventListener('change', async () => {
    await setLang(langSel.value as Lang);
    localStorage.setItem('fl-lang', langSel.value);
    refreshTexts();
  });
  $('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    setTheme(dark);
    localStorage.setItem('fl-theme', dark ? 'dark' : 'light');
    update();
  });
}

function setTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('theme');
  btn.setAttribute('aria-pressed', String(dark));
  btn.textContent = t(dark ? 'theme.light' : 'theme.dark');
}

/** Everything that holds translated text and is not covered by data-i18n. */
function refreshTexts(): void {
  setTheme(document.documentElement.dataset.theme === 'dark');
  stopTimelapse();
  fillAdmin();
  renderMethods();
  update();
}

/* ------------------------------------------------------------------ downloads */

function setupDownloads(): void {
  const status = (text: string): void => {
    $('dl-status').textContent = text;
  };
  const chartSvg = (id: string) => $(id).querySelector('svg');
  const fileBase = () => `fireledger_${region.meta.code}_${ymText(state.fromYm)}_${ymText(state.toYm)}`;

  const actions: Record<string, () => Promise<void> | void> = {
    'matrix-csv': () => downloadBlob(new Blob([matrixCsv(model)], { type: 'text/csv' }), `${fileBase()}_calendar.csv`),
    'hotspots-csv': async () => {
      const res = await hotspotsCsv(region.meta.code, region.meta.bbox, state.aoi, state.fromYm, state.toYm, state.includeStatic, region.meta.years, (year) => status(t('dl.preparing', { year })));
      if (!res.rows) return status(t('dl.norows'));
      downloadBlob(new Blob([res.csv], { type: 'text/csv' }), `${fileBase()}_hotspots.csv`);
      status(t('dl.rows', { rows: fmt(res.rows) }));
    },
    'calendar-png': async () => {
      const svg = await calendarSvg();
      if (svg) await downloadPng(svg, `${fileBase()}_calendar.png`);
    },
    'calendar-svg': async () => {
      const svg = await calendarSvg();
      if (svg) downloadSvg(svg, `${fileBase()}_calendar.svg`);
    },
    'annual-png': () => downloadPng(chartSvg('chart-annual')!, `${fileBase()}_annual.png`),
    'season-png': () => downloadPng(chartSvg('chart-season')!, `${fileBase()}_season.png`),
    'top-png': () => downloadPng(chartSvg('chart-top')!, `${fileBase()}_top10.png`),
    'briefing-pdf': async () => {
      status(t('dl.pdf'));
      const { briefingPdf } = await import('./export/pdf');
      const svg = await calendarSvg();
      const cell = focus?.cell;
      const cls = classify(cell?.anomalyPct ?? null);
      await briefingPdf({
        areaName: aoiName(),
        rangeLabel: `${ymText(state.fromYm)} – ${ymText(state.toYm)}`,
        mapPng: map.snapshot(),
        calendar: svg ? await svgToCanvas(svg, 2, '#ffffff') : null,
        nowLines: cell
          ? [
              `${monthName(cell.month, 'long')} ${cell.year}: ${fmt(cell.value ?? 0)} ${t('unit.fcd')}`,
              `${t('now.median')}: ${cell.median === null ? '–' : fmt(cell.median)} · ${t('now.anomaly')}: ${cell.anomalyPct === null ? '–' : `${signed(cell.anomalyPct)} %`}`,
              `${t('now.percentile')}: ${cell.percentile === null ? '–' : Math.round(cell.percentile)}${cls ? ` · ${t(`class.${cls}`)}` : ''}`,
            ]
          : [],
        sentence: cell ? sentence(cell) : '',
        advisory,
        methodLine: t('pdf.method', { b0: model.baseline[0], b1: model.baseline[1], start: region.meta.data_start, end: region.meta.data_end }),
      });
      status(t('dl.done'));
    },
  };

  /** The calendar as SVG, also when the table view is showing. */
  async function calendarSvg(): Promise<SVGSVGElement | null> {
    if (state.view !== 'table') return chartSvg('calendar');
    const holder = document.createElement('div');
    renderHeatmap(holder, model, { mode: state.mode, currentYm: focus?.cell.ym ?? null });
    return holder.querySelector('svg');
  }

  document.querySelectorAll<HTMLButtonElement>('[data-dl]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await actions[btn.dataset.dl!]?.();
      } catch (err) {
        status(t('dl.failed', { reason: (err as Error).message }));
      } finally {
        btn.disabled = false;
      }
    }),
  );

  $('share').addEventListener('click', async () => {
    syncUrl();
    await navigator.clipboard.writeText(location.href.replace(location.origin, 'https://fireledger.earth'));
    status(t('dl.copied'));
  });

  // advisory buttons are re-created on every render: delegate
  $('advisory').addEventListener('click', async (ev) => {
    const btn = (ev.target as Element).closest<HTMLButtonElement>('[data-adv]');
    if (!btn || !advisory) return;
    const note = document.getElementById('adv-status');
    try {
      if (btn.dataset.adv === 'sms') {
        await navigator.clipboard.writeText(advisory.sms);
        if (note) note.textContent = `${t('dl.copied')} (${advisory.sms.length}/600)`;
      } else {
        if (note) note.textContent = t('dl.pdf');
        const { advisoryPdf } = await import('./export/pdf');
        await advisoryPdf(advisory, aoiName());
        if (note) note.textContent = t('dl.done');
      }
    } catch (err) {
      if (note) note.textContent = t('dl.failed', { reason: (err as Error).message });
    }
  });
}

/* ------------------------------------------------------------------ start */

async function start(): Promise<void> {
  const wanted = params.get('lang') ?? localStorage.getItem('fl-lang') ?? navigator.language.slice(0, 2);
  await setLang(isLang(wanted) ? wanted : 'en');
  ($('lang') as HTMLSelectElement).value = getLang();
  setTheme(localStorage.getItem('fl-theme') === 'dark');
  setStatus('loading', t('loading.data'));

  try {
    region = await loadRegion(REGION);
  } catch {
    return setStatus('loading', t('loading.error'), 'danger');
  }
  admin = await fetch(`${import.meta.env.BASE_URL}data/${REGION}/adm1.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);

  state.aoi = decodeAoi(params.get('aoi')) ?? { kind: 'region' };
  setupRange();
  map = new FireMap($('map'), aoiBbox(state.aoi, region.meta.bbox));
  setupArea();
  setupControls();
  setupDownloads();
  fillAdmin();
  renderMethods();

  // analytics and the live feed do not wait for the basemap
  update();
  setStatus('loading', '');
  void loadLive();
  void map.ready.then(() => {
    mapReady = true;
    renderMapData();
    renderLive();
  });

  if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

void start();
