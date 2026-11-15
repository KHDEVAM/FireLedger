import * as d3 from 'd3';
import { fonts, tok } from '../colors';
import { fmt, monthName, t } from '../i18n';
import { median, type Summary } from '../stats';
import type { CalCell, CalendarModel } from '../types';
import { hideTooltip, showTooltip } from '../ui';

function frame(container: HTMLElement, width: number, height: number, label: string) {
  container.innerHTML = '';
  return d3
    .select(container)
    .append('svg')
    .attr('xmlns', 'http://www.w3.org/2000/svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', label)
    .attr('direction', 'ltr')
    .attr('font-family', fonts.body())
    .attr('font-size', 11);
}

function styleAxis(g: d3.Selection<SVGGElement, unknown, null, undefined>) {
  g.selectAll('text').attr('fill', tok('--text')).attr('font-family', fonts.body());
  g.selectAll('line,path').attr('stroke', tok('--grid'));
}

function hover(node: Element, lines: string[]) {
  node.addEventListener('mouseenter', () => showTooltip(node, lines));
  node.addEventListener('mouseleave', hideTooltip);
}

/** Annual totals with the Theil-Sen trend line. Incomplete years are drawn lighter. */
export function renderAnnual(container: HTMLElement, s: Summary): void {
  const W = 460;
  const H = 240;
  const m = { l: 44, r: 10, t: 10, b: 26 };
  const svg = frame(container, W, H, t('charts.annual'));
  if (!s.annual.length) return;
  const x = d3.scaleBand<number>().domain(s.annual.map((a) => a.year)).range([m.l, W - m.r]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(s.annual, (a) => a.total)! * 1.08 || 1]).nice().range([H - m.b, m.t]);
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(x.domain().filter((yr) => yr % 5 === 0)).tickSizeOuter(0)).call(styleAxis);
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).call(styleAxis);
  s.annual.forEach((a) => {
    const rect = svg
      .append('rect')
      .attr('x', x(a.year)!)
      .attr('y', y(a.total))
      .attr('width', x.bandwidth())
      .attr('height', y(0) - y(a.total))
      .attr('fill', tok('--fl-fire-orange'))
      .attr('opacity', a.complete ? 1 : 0.4);
    hover(rect.node()!, [String(a.year), `${fmt(a.total)} ${t('unit.fcd')}`, ...(a.complete ? [] : [t('charts.incomplete')])]);
  });
  const full = s.annual.filter((a) => a.complete);
  if (Number.isFinite(s.trendPerYear) && full.length) {
    const intercept = median(full.map((a) => a.total - s.trendPerYear * a.year));
    const f = (yr: number) => y(Math.max(intercept + s.trendPerYear * yr, 0));
    svg
      .append('line')
      .attr('x1', x(full[0].year)! + x.bandwidth() / 2)
      .attr('x2', x(full[full.length - 1].year)! + x.bandwidth() / 2)
      .attr('y1', f(full[0].year))
      .attr('y2', f(full[full.length - 1].year))
      .attr('stroke', tok('--text'))
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '6 4');
  }
}

/** Median month curve with IQR band and the selected year on top. */
export function renderSeason(container: HTMLElement, s: Summary, yearRow: CalCell[], year: number, baseline: [number, number]): void {
  const W = 460;
  const H = 240;
  const m = { l: 44, r: 10, t: 10, b: 26 };
  const svg = frame(container, W, H, t('charts.season'));
  const vals = [...s.profile.map((p) => p.q3), ...yearRow.map((c) => c.value ?? 0)].filter(Number.isFinite);
  const x = d3.scalePoint<number>().domain(d3.range(1, 13)).range([m.l + 12, W - m.r - 12]);
  const y = d3.scaleLinear().domain([0, (d3.max(vals) ?? 1) * 1.08 || 1]).nice().range([H - m.b, m.t]);
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((d) => monthName(d as number, 'narrow')).tickSizeOuter(0)).call(styleAxis);
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).call(styleAxis);
  const ok = s.profile.filter((p) => Number.isFinite(p.median));
  svg
    .append('path')
    .attr('d', d3.area<(typeof ok)[number]>().x((p) => x(p.month)!).y0((p) => y(p.q1)).y1((p) => y(p.q3))(ok))
    .attr('fill', tok('--fl-orbit-blue'))
    .attr('opacity', 0.3);
  svg
    .append('path')
    .attr('d', d3.line<(typeof ok)[number]>().x((p) => x(p.month)!).y((p) => y(p.median))(ok))
    .attr('fill', 'none')
    .attr('stroke', tok('--link'))
    .attr('stroke-width', 2);
  const pts = yearRow.filter((c) => c.value !== null);
  svg
    .append('path')
    .attr('d', d3.line<CalCell>().x((c) => x(c.month)!).y((c) => y(c.value as number))(pts))
    .attr('fill', 'none')
    .attr('stroke', tok('--fl-ember-red'))
    .attr('stroke-width', 2.5);
  pts.forEach((c) => {
    const dot = svg.append('circle').attr('cx', x(c.month)!).attr('cy', y(c.value as number)).attr('r', 4).attr('fill', tok('--fl-ember-red')).attr('stroke', tok('--surface'));
    hover(dot.node()!, [`${monthName(c.month, 'long')} ${year}`, `${fmt(c.value as number)} ${t('unit.fcd')}`, `${t('now.median')}: ${fmt(s.profile[c.month - 1].median)}`]);
  });
  // direct labels instead of a color-only legend
  const lg = svg.append('g').attr('font-size', 10).attr('fill', tok('--text'));
  lg.append('line').attr('x1', m.l + 8).attr('x2', m.l + 26).attr('y1', m.t + 6).attr('y2', m.t + 6).attr('stroke', tok('--fl-ember-red')).attr('stroke-width', 2.5);
  lg.append('text').attr('x', m.l + 30).attr('y', m.t + 9).text(String(year));
  lg.append('line').attr('x1', m.l + 70).attr('x2', m.l + 88).attr('y1', m.t + 6).attr('y2', m.t + 6).attr('stroke', tok('--link')).attr('stroke-width', 2);
  lg.append('text').attr('x', m.l + 92).attr('y', m.t + 9).text(t('charts.medianiqr', { b0: baseline[0], b1: baseline[1] }));
}

export function renderTop(container: HTMLElement, s: Summary): void {
  const W = 460;
  const rowH = 21;
  const m = { l: 76, r: 46, t: 6, b: 6 };
  const H = m.t + m.b + rowH * Math.max(s.top.length, 1);
  const svg = frame(container, W, H, t('charts.top'));
  const x = d3.scaleLinear().domain([0, s.top[0]?.value ?? 1]).range([0, W - m.l - m.r]);
  s.top.forEach((c, i) => {
    const y = m.t + i * rowH;
    svg.append('text').attr('x', m.l - 6).attr('y', y + 14).attr('text-anchor', 'end').attr('fill', tok('--text')).text(`${monthName(c.month, 'short')} ${c.year}`);
    svg.append('rect').attr('x', m.l).attr('y', y + 3).attr('width', x(c.value as number)).attr('height', rowH - 6).attr('fill', tok('--fl-deep-red'));
    svg.append('text').attr('x', m.l + x(c.value as number) + 4).attr('y', y + 14).attr('fill', tok('--text')).style('font-variant-numeric', 'tabular-nums').text(fmt(c.value as number));
  });
}

/** Box plot of one calendar month across all years, with the current value marked. */
export function renderBox(container: HTMLElement, model: CalendarModel, cell: CalCell): void {
  const W = 300;
  const H = 86;
  const m = { l: 10, r: 14, t: 22, b: 24 };
  const svg = frame(container, W, H, t('now.boxalt', { month: monthName(cell.month, 'long') }));
  const vals = model.cells.map((r) => r[cell.month - 1]).filter((c) => c.value !== null).map((c) => c.value as number);
  if (!vals.length) return;
  const q = (p: number) => d3.quantile([...vals].sort(d3.ascending), p)!;
  const x = d3.scaleLinear().domain([0, Math.max(d3.max(vals)!, 1)]).nice().range([m.l, W - m.r]);
  const mid = m.t + (H - m.t - m.b) / 2;
  const ink = tok('--text');
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(4).tickSizeOuter(0)).call(styleAxis);
  svg.append('line').attr('x1', x(d3.min(vals)!)).attr('x2', x(d3.max(vals)!)).attr('y1', mid).attr('y2', mid).attr('stroke', ink);
  svg.append('rect').attr('x', x(q(0.25))).attr('width', Math.max(x(q(0.75)) - x(q(0.25)), 1)).attr('y', mid - 10).attr('height', 20).attr('fill', tok('--fl-orbit-blue')).attr('opacity', 0.45).attr('stroke', ink);
  svg.append('line').attr('x1', x(q(0.5))).attr('x2', x(q(0.5))).attr('y1', mid - 10).attr('y2', mid + 10).attr('stroke', ink).attr('stroke-width', 2.5);
  vals.forEach((v) => svg.append('circle').attr('cx', x(v)).attr('cy', mid).attr('r', 2).attr('fill', ink).attr('opacity', 0.45));
  const cx = x(cell.value ?? 0);
  svg.append('path').attr('d', `M${cx},${mid - 11} l-6,-9 h12 z`).attr('fill', tok('--fl-ember-red')).attr('stroke', tok('--surface'));
  svg.append('text').attr('x', Math.min(Math.max(cx, 30), W - 30)).attr('y', 9).attr('text-anchor', 'middle').attr('fill', ink).attr('font-weight', 700).attr('font-size', 10).text(`${cell.year}: ${fmt(cell.value ?? 0)}`);
}

/* ---------- table alternatives ---------- */

const table = (caption: string, head: string[], rows: (string | number)[][]) =>
  `<table><caption>${caption}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table>`;

export function annualTable(s: Summary): string {
  return table(t('charts.annual'), [t('table.year'), t('unit.fcd'), t('table.complete')], s.annual.map((a) => [a.year, fmt(a.total), a.complete ? t('yes') : t('no')]));
}

export function seasonTable(s: Summary, yearRow: CalCell[], year: number): string {
  return table(
    t('charts.season'),
    [t('table.month'), t('now.median'), 'Q1', 'Q3', String(year)],
    s.profile.map((p, i) => [monthName(p.month, 'long'), fmt(p.median), fmt(p.q1), fmt(p.q3), yearRow[i]?.value == null ? t('cal.nodata') : fmt(yearRow[i].value as number)]),
  );
}

export function topTable(s: Summary): string {
  return table(t('charts.top'), [t('table.month'), t('unit.fcd'), t('now.anomaly')], s.top.map((c) => [`${monthName(c.month, 'long')} ${c.year}`, fmt(c.value as number), c.anomalyPct === null ? '–' : `${fmt(c.anomalyPct)} %`]));
}
