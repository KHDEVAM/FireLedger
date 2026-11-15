import * as d3 from 'd3';
import { anomalyColor, ANOMALY_LIMITS, countScale, divergingColors, fonts, rampColors, textOn, tok, zeroColor } from '../colors';
import { fmt, monthName, t } from '../i18n';
import type { CalCell, CalendarModel } from '../types';
import { hideTooltip, showTooltip } from '../ui';

export type ColorMode = 'count' | 'anomaly';

export interface CalendarOptions {
  mode: ColorMode;
  currentYm: number | null;
}

/** Fill of one cell; null means "draw the no-data hatch". */
export function cellFill(cell: CalCell, mode: ColorMode, scale: ReturnType<typeof countScale>): string | null {
  if (cell.value === null) return null;
  if (mode === 'count') return scale.color(cell.value);
  return cell.anomalyPct === null ? zeroColor() : anomalyColor(cell.anomalyPct);
}

export function modelScale(model: CalendarModel) {
  return countScale(model.cells.flat().map((c) => c.value ?? 0));
}

export function sourceNote(cell: CalCell): string {
  if (cell.src === 'modis_only') return t('src.modisonly');
  if (cell.src === 'viirs_obs') return t('src.viirs');
  if (cell.value && cell.lo !== null && cell.hi !== null) {
    const down = Math.round(((cell.value - cell.lo) / cell.value) * 100);
    const up = Math.round(((cell.hi - cell.value) / cell.value) * 100);
    return t('src.modis', { down, up });
  }
  return t('src.modis0');
}

export function cellDescription(cell: CalCell): string[] {
  const title = `${monthName(cell.month, 'long')} ${cell.year}`;
  if (cell.value === null) return [title, t('cal.nodata') + (cell.note ? ` (${cell.note})` : '')];
  const lines = [title, `${t('tip.count')}: ${fmt(cell.value)}`];
  if (cell.median !== null) lines.push(`${t('now.median')}: ${fmt(cell.median)}`);
  if (cell.anomalyPct !== null) lines.push(`${t('now.anomaly')}: ${signed(cell.anomalyPct)} %`);
  if (cell.percentile !== null) lines.push(`${t('now.percentile')}: ${Math.round(cell.percentile)}`);
  lines.push(sourceNote(cell));
  if (cell.status === 'partial') lines.push(`${t('cal.partial')}: ${cell.note}`);
  return lines;
}

export const signed = (v: number): string => `${v > 0 ? '+' : ''}${fmt(v)}`;

function compact(v: number): string {
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function renderHeatmap(container: HTMLElement, model: CalendarModel, opts: CalendarOptions): void {
  const cw = 46;
  const ch = 24;
  const left = 46;
  const top = 24;
  const width = left + cw * 12 + 6;
  const height = top + ch * model.years.length + 6;
  const scale = modelScale(model);
  const rtl = document.documentElement.dir === 'rtl';
  const x = (mi: number) => (rtl ? width - left - cw * (mi + 1) : left + cw * mi);

  container.innerHTML = '';
  const svg = d3
    .select(container)
    .append('svg')
    .attr('xmlns', 'http://www.w3.org/2000/svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'grid')
    .attr('direction', 'ltr')
    .attr('aria-label', t('cal.title'))
    .attr('font-family', fonts.body())
    .attr('font-size', 11);

  const hatch = tok('--hatch');
  svg
    .append('defs')
    .append('pattern')
    .attr('id', 'nodata-hatch')
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6)
    .attr('height', 6)
    .attr('patternTransform', 'rotate(45)')
    .call((p) => p.append('rect').attr('width', 6).attr('height', 6).attr('fill', tok('--surface')))
    .call((p) => p.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', hatch).attr('stroke-width', 2));

  const text = tok('--text');
  for (let mi = 0; mi < 12; mi++)
    svg
      .append('text')
      .attr('x', x(mi) + cw / 2)
      .attr('y', 15)
      .attr('text-anchor', 'middle')
      .attr('fill', text)
      .attr('font-weight', 600)
      .text(monthName(mi + 1, 'short'));

  model.years.forEach((year, yi) => {
    const y = top + yi * ch;
    svg
      .append('text')
      .attr('x', rtl ? width - left + 6 : left - 6)
      .attr('y', y + ch / 2 + 4)
      .attr('text-anchor', rtl ? 'start' : 'end')
      .attr('fill', text)
      .attr('font-weight', 600)
      .style('font-variant-numeric', 'tabular-nums')
      .text(year);
    const row = svg.append('g').attr('role', 'row');
    model.cells[yi].forEach((cell, mi) => {
      const fill = cellFill(cell, opts.mode, scale);
      const g = row
        .append('g')
        .attr('role', 'gridcell')
        .attr('tabindex', yi === model.years.length - 1 && mi === 0 ? 0 : -1)
        .attr('data-pos', `${yi}-${mi}`)
        .attr('aria-label', cellDescription(cell).join('. '))
        .attr('opacity', cell.inRange ? 1 : 0.28)
        .style('outline-offset', '-2px');
      g.append('rect')
        .attr('x', x(mi) + 0.5)
        .attr('y', y + 0.5)
        .attr('width', cw - 1)
        .attr('height', ch - 1)
        .attr('rx', 2)
        .attr('fill', fill ?? 'url(#nodata-hatch)');
      if (fill && cell.value !== null && cell.value > 0)
        g.append('text')
          .attr('x', x(mi) + cw / 2)
          .attr('y', y + ch / 2 + 4)
          .attr('text-anchor', 'middle')
          .attr('fill', textOn(fill))
          .style('font-variant-numeric', 'tabular-nums')
          .text(compact(cell.value));
      if (cell.status === 'partial')
        g.append('path')
          .attr('d', `M${x(mi) + cw - 9},${y + 1} h8 v8 z`)
          .attr('fill', tok('--outline-now'))
          .attr('opacity', 0.7);
      if (cell.ym === opts.currentYm)
        g.append('rect')
          .attr('x', x(mi) + 1.5)
          .attr('y', y + 1.5)
          .attr('width', cw - 3)
          .attr('height', ch - 3)
          .attr('rx', 2)
          .attr('fill', 'none')
          .attr('stroke', tok('--outline-now'))
          .attr('stroke-width', 2.5);
      const node = g.node() as SVGGElement;
      const tip = () => showTooltip(node, cellDescription(cell));
      node.addEventListener('mouseenter', tip);
      node.addEventListener('focus', tip);
      node.addEventListener('mouseleave', hideTooltip);
      node.addEventListener('blur', hideTooltip);
    });
  });

  // roving focus with the arrow keys
  const el = svg.node() as SVGSVGElement;
  el.addEventListener('keydown', (ev) => {
    const cur = (ev.target as Element).closest('[data-pos]');
    if (!cur) return;
    const [yi, mi] = cur.getAttribute('data-pos')!.split('-').map(Number);
    const step = rtl ? -1 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowRight: [0, step],
      ArrowLeft: [0, -step],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const mv = moves[ev.key];
    if (!mv) return;
    const next = el.querySelector<SVGGElement>(`[data-pos="${yi + mv[0]}-${mi + mv[1]}"]`);
    if (next) {
      ev.preventDefault();
      cur.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    }
  });
}

export function renderLegend(container: HTMLElement, model: CalendarModel, mode: ColorMode): void {
  const sw = (color: string, label: string) => `<span><span class="sw" style="background:${color}"></span>${label}</span>`;
  const parts: string[] = [];
  if (mode === 'count') {
    const scale = modelScale(model);
    const colors = rampColors();
    parts.push(sw(zeroColor(), '0'));
    const edges = [0, ...scale.breaks];
    edges.forEach((lo, k) => {
      const hi = scale.breaks[k];
      const idx = scale.breaks.length ? Math.round((k / scale.breaks.length) * (colors.length - 1)) : 2;
      const label = hi === undefined ? `≥ ${fmt(Math.max(lo, 1))}` : `${fmt(Math.max(lo, 1))}–${fmt(hi)}`;
      parts.push(sw(colors[idx], label));
    });
    parts.push(`<span>${t('unit.fcd')}</span>`);
  } else {
    const colors = divergingColors();
    const lim = ANOMALY_LIMITS;
    const labels = [
      `< ${lim[0]} %`,
      `${lim[0]} … ${lim[1]} %`,
      `${lim[1]} … ${lim[2]} %`,
      `${lim[2]} … +${lim[3]} % (${t('class.normal')})`,
      `+${lim[3]} … +${lim[4]} %`,
      `+${lim[4]} … +${lim[5]} %`,
      `> +${lim[5]} %`,
    ];
    colors.forEach((c, i) => parts.push(sw(c, labels[i])));
  }
  parts.push(
    `<span><svg width="18" height="12" aria-hidden="true"><defs><pattern id="lg-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="${tok('--hatch')}" stroke-width="2"/></pattern></defs><rect width="18" height="12" fill="url(#lg-hatch)" stroke="${tok('--border')}"/></svg> ${t('cal.nodata')}</span>`,
  );
  parts.push(`<span>◥ ${t('cal.partial')}</span>`, `<span>▢ ${t('cal.current')}</span>`);
  container.innerHTML = parts.join('');
}

/** Accessible table alternative of the calendar. */
export function renderCalendarTable(container: HTMLElement, model: CalendarModel, mode: ColorMode): void {
  const head = Array.from({ length: 12 }, (_, i) => `<th scope="col">${monthName(i + 1, 'short')}</th>`).join('');
  const body = model.cells
    .map((row, yi) => {
      const tds = row
        .map((c) => {
          if (c.value === null) return `<td>${t('cal.nodata')}</td>`;
          const v = mode === 'count' ? fmt(c.value) : c.anomalyPct === null ? '–' : `${signed(c.anomalyPct)} %`;
          return `<td>${v}${c.status === 'partial' ? ' *' : ''}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${model.years[yi]}</th>${tds}</tr>`;
    })
    .join('');
  const caption = mode === 'count' ? t('table.cal.count') : t('table.cal.anomaly');
  container.innerHTML = `<div class="table-wrap"><table><caption>${caption}</caption><thead><tr><th scope="col">${t('table.year')}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
