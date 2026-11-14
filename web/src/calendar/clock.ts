import * as d3 from 'd3';
import { fonts, tok } from '../colors';
import { monthName, t } from '../i18n';
import type { CalendarModel } from '../types';
import { hideTooltip, showTooltip } from '../ui';
import { cellDescription, cellFill, modelScale, type CalendarOptions } from './heatmap';

/** Fire Season Clock: months around the circle, years as rings (oldest inside). */
export function renderClock(container: HTMLElement, model: CalendarModel, opts: CalendarOptions): void {
  const size = 560;
  const rOuter = size / 2 - 34;
  const rInner = 46;
  const ring = (rOuter - rInner) / model.years.length;
  const scale = modelScale(model);
  const step = (2 * Math.PI) / 12;

  container.innerHTML = '';
  const svg = d3
    .select(container)
    .append('svg')
    .attr('xmlns', 'http://www.w3.org/2000/svg')
    .attr('viewBox', `0 0 ${size} ${size}`)
    .attr('width', size)
    .attr('height', size)
    .attr('role', 'img')
    .attr('aria-label', `${t('cal.clock')}. ${t('clock.alt')}`)
    .attr('font-family', fonts.body())
    .attr('font-size', 11);

  svg
    .append('defs')
    .append('pattern')
    .attr('id', 'clock-hatch')
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 5)
    .attr('height', 5)
    .attr('patternTransform', 'rotate(45)')
    .append('line')
    .attr('x1', 0)
    .attr('y1', 0)
    .attr('x2', 0)
    .attr('y2', 5)
    .attr('stroke', tok('--hatch'))
    .attr('stroke-width', 1.5);

  const g = svg.append('g').attr('transform', `translate(${size / 2},${size / 2})`);
  const arc = d3.arc<{ r0: number; r1: number; a0: number; a1: number }>()
    .innerRadius((d) => d.r0)
    .outerRadius((d) => d.r1)
    .startAngle((d) => d.a0)
    .endAngle((d) => d.a1);

  model.cells.forEach((row, yi) => {
    row.forEach((cell, mi) => {
      const fill = cellFill(cell, opts.mode, scale);
      const d = { r0: rInner + yi * ring, r1: rInner + (yi + 1) * ring, a0: mi * step, a1: (mi + 1) * step };
      const path = g
        .append('path')
        .attr('d', arc(d))
        .attr('fill', fill ?? 'url(#clock-hatch)')
        .attr('stroke', cell.ym === opts.currentYm ? tok('--outline-now') : tok('--surface'))
        .attr('stroke-width', cell.ym === opts.currentYm ? 2.5 : 0.4)
        .attr('opacity', cell.inRange ? 1 : 0.28);
      const node = path.node() as SVGPathElement;
      node.addEventListener('mouseenter', () => showTooltip(node, cellDescription(cell)));
      node.addEventListener('mouseleave', hideTooltip);
    });
  });

  const text = tok('--text');
  for (let mi = 0; mi < 12; mi++) {
    const a = (mi + 0.5) * step - Math.PI / 2;
    g.append('text')
      .attr('x', Math.cos(a) * (rOuter + 16))
      .attr('y', Math.sin(a) * (rOuter + 16) + 4)
      .attr('text-anchor', 'middle')
      .attr('fill', text)
      .attr('font-weight', 600)
      .text(monthName(mi + 1, 'short'));
  }
  // year labels along the January boundary
  model.years.forEach((year, yi) => {
    if (yi !== 0 && yi !== model.years.length - 1 && year % 5 !== 0) return;
    g.append('text')
      .attr('x', 2)
      .attr('y', -(rInner + (yi + 0.5) * ring) + 3)
      .attr('fill', text)
      .attr('font-size', 8)
      .attr('paint-order', 'stroke')
      .attr('stroke', tok('--surface'))
      .attr('stroke-width', 2)
      .text(year);
  });
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('y', 4)
    .attr('fill', text)
    .attr('font-family', fonts.head())
    .attr('font-weight', 800)
    .attr('font-size', 12)
    .text(`${model.years[0]}–${model.years[model.years.length - 1]}`);
}
