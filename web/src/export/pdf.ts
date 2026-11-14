/**
 * PDF export. Pages are composed on a canvas (so any language, including
 * right-to-left Arabic, is shaped by the browser) and placed into an A4 PDF.
 */
import type { AdvisoryDoc } from '../advisory/panel';
import { tok } from '../colors';
import { t } from '../i18n';
import { loadImage } from './image';

const W = 1654; // A4 at 200 dpi
const H = 2339;
const M = 90;

class Composer {
  pages: HTMLCanvasElement[] = [];
  ctx!: CanvasRenderingContext2D;
  y = M;
  private rtl = document.documentElement.dir === 'rtl';
  private ink = tok('--fl-ledger-navy');
  private muted = tok('--fl-slate');

  constructor() {
    this.newPage();
  }

  newPage(): void {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    this.ctx = c.getContext('2d')!;
    this.ctx.fillStyle = tok('--fl-paper');
    this.ctx.fillRect(0, 0, W, H);
    this.ctx.direction = this.rtl ? 'rtl' : 'ltr';
    this.ctx.textBaseline = 'top';
    this.pages.push(c);
    this.y = M;
  }

  ensure(height: number): void {
    if (this.y + height > H - M) this.newPage();
  }

  /** Wrapped paragraph inside [x, x + width]. Returns the height used. */
  text(str: string, opts: { size?: number; weight?: number; color?: string; x?: number; width?: number; head?: boolean; gap?: number; muted?: boolean } = {}): number {
    const size = opts.size ?? 26;
    const x = opts.x ?? M;
    const width = opts.width ?? W - 2 * M;
    const lh = Math.round(size * 1.38);
    this.ctx.font = `${opts.weight ?? 400} ${size}px ${opts.head ? tok('--font-head') : tok('--font-body')}`;
    this.ctx.fillStyle = opts.color ?? (opts.muted ? this.muted : this.ink);
    this.ctx.textAlign = this.rtl ? 'right' : 'left';
    const lines: string[] = [];
    let line = '';
    for (const word of str.split(/\s+/)) {
      const probe = line ? `${line} ${word}` : word;
      if (this.ctx.measureText(probe).width > width && line) {
        lines.push(line);
        line = word;
      } else line = probe;
    }
    if (line) lines.push(line);
    const start = this.y;
    for (const l of lines) {
      this.ensure(lh);
      this.ctx.fillText(l, this.rtl ? x + width : x, this.y);
      this.y += lh;
    }
    this.y += opts.gap ?? 8;
    return this.y - start;
  }

  signature(): void {
    const g = this.ctx.createLinearGradient(M, 0, W - M, 0);
    g.addColorStop(0, tok('--fl-fire-orange'));
    g.addColorStop(0.6, tok('--fl-ember-red'));
    g.addColorStop(1, tok('--fl-ledger-navy'));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(M, this.y, W - 2 * M, 8);
    this.y += 30;
  }

  image(img: CanvasImageSource, iw: number, ih: number, x: number, maxW: number, maxH: number, advance = true): number {
    const k = Math.min(maxW / iw, maxH / ih);
    const w = iw * k;
    const h = ih * k;
    if (advance) this.ensure(h);
    this.ctx.drawImage(img, x, this.y, w, h);
    this.ctx.strokeStyle = tok('--border');
    this.ctx.strokeRect(x, this.y, w, h);
    if (advance) this.y += h + 20;
    return h;
  }

  async header(title: string, subtitle: string): Promise<void> {
    try {
      const logo = await loadImage(`${import.meta.env.BASE_URL}brand/logo-header.png`);
      const h = 120;
      const w = (logo.naturalWidth / logo.naturalHeight) * h;
      this.ctx.drawImage(logo, this.rtl ? W - M - w : M, this.y, w, h);
      const tx = this.rtl ? M : M + w + 40;
      const yy = this.y;
      this.y = yy + 14;
      this.text(title, { size: 44, weight: 800, head: true, x: tx, width: W - 2 * M - w - 40, gap: 2 });
      this.text(subtitle, { size: 24, muted: true, x: tx, width: W - 2 * M - w - 40 });
      this.y = Math.max(this.y, yy + h + 16);
    } catch {
      this.text(`FireLedger — ${title}`, { size: 44, weight: 800, head: true });
      this.text(subtitle, { size: 24, muted: true });
    }
    this.signature();
  }

  footer(): void {
    for (const page of this.pages) {
      const ctx = page.getContext('2d')!;
      ctx.font = `400 19px ${tok('--font-body')}`;
      ctx.fillStyle = this.muted;
      ctx.textAlign = 'center';
      ctx.direction = 'ltr';
      ctx.fillText('https://fireledger.earth · NASA FIRMS (MODIS C6.1, VIIRS 375 m) · © OpenStreetMap contributors · Open-Meteo', W / 2, H - 64);
    }
  }

  async save(name: string): Promise<void> {
    this.footer();
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    this.pages.forEach((page, i) => {
      if (i) pdf.addPage();
      pdf.addImage(page.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 595.28, 841.89);
    });
    pdf.save(name);
  }
}

export interface BriefingInput {
  areaName: string;
  rangeLabel: string;
  mapPng: string | null;
  calendar: HTMLCanvasElement | null;
  nowLines: string[];
  sentence: string;
  advisory: AdvisoryDoc | null;
  methodLine: string;
}

/** One-page "Fire Situation Briefing". */
export async function briefingPdf(input: BriefingInput): Promise<void> {
  const c = new Composer();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await c.header(t('pdf.briefing'), `${input.areaName} · ${input.rangeLabel} · ${t('pdf.generated')} ${stamp} UTC`);

  const colW = (W - 2 * M - 40) / 2;
  const top = c.y;
  let mapH = 0;
  if (input.mapPng) {
    try {
      const img = await loadImage(input.mapPng);
      mapH = c.image(img, img.naturalWidth, img.naturalHeight, M, colW, 520, false);
    } catch {
      /* map snapshot is optional */
    }
  }
  const tx = M + colW + 40;
  c.text(t('now.title'), { size: 30, weight: 700, head: true, x: tx, width: colW });
  input.nowLines.forEach((l, i) => c.text(l, { size: i === 0 ? 34 : 25, weight: i === 0 ? 800 : 400, x: tx, width: colW, gap: 4 }));
  if (input.sentence) c.text(input.sentence, { size: 24, x: tx, width: colW, color: tok('--fl-deep-red'), gap: 4 });
  c.y = Math.max(c.y, top + mapH) + 26;

  const rowTop = c.y;
  let calH = 0;
  if (input.calendar) {
    c.text(t('cal.title'), { size: 30, weight: 700, head: true, width: colW });
    calH = c.image(input.calendar, input.calendar.width, input.calendar.height, M, colW + 60, 1000, false);
    calH += c.y - rowTop;
  }
  c.y = rowTop;
  const ax = M + colW + 100;
  const aw = W - M - ax;
  c.text(t('live.title'), { size: 30, weight: 700, head: true, x: ax, width: aw });
  if (input.advisory) {
    const a = input.advisory;
    if (a.simulated) c.text(t('adv.simulated'), { size: 22, weight: 700, x: ax, width: aw, color: tok('--fl-deep-red') });
    c.text(`${t('adv.tierword')} ${a.tier} · ${a.tierLabel}`, { size: 30, weight: 800, x: ax, width: aw, color: a.tier >= 3 ? tok('--fl-deep-red') : undefined });
    c.text(a.headline, { size: 23, x: ax, width: aw });
    a.triggers.slice(0, 5).forEach((tr) => c.text(`• ${tr}`, { size: 21, x: ax, width: aw, gap: 2, muted: true }));
    for (const card of a.cards.slice(0, 3)) {
      c.text(card.title, { size: 23, weight: 700, x: ax, width: aw, gap: 2 });
      card.items.slice(0, 4).forEach((i) => c.text(`• ${i.text}`, { size: 20, x: ax, width: aw, gap: 2 }));
    }
  } else c.text(t('pdf.noadvisory'), { size: 23, x: ax, width: aw, muted: true });
  c.y = Math.max(c.y, rowTop + calH) + 24;

  c.text(input.methodLine, { size: 20, muted: true });
  c.text(`${t('adv.guard.support')} ${t('footer.safety')}`, { size: 20, weight: 600 });
  c.text(t('footer.firms'), { size: 18, muted: true, gap: 2 });
  c.text(t('footer.nasa'), { size: 18, muted: true });
  await c.save('fireledger-briefing.pdf');
}

/** Full advisory as a PDF (may run over several pages). */
export async function advisoryPdf(doc: AdvisoryDoc, areaName: string): Promise<void> {
  const c = new Composer();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await c.header(t('pdf.advisory'), `${areaName} · ${t('pdf.generated')} ${stamp} UTC`);
  if (doc.simulated) c.text(t('adv.simulated'), { size: 26, weight: 800, color: tok('--fl-deep-red') });
  c.text(`${t('adv.tierword')} ${doc.tier} · ${doc.tierLabel}`, { size: 40, weight: 800, head: true, color: doc.tier >= 3 ? tok('--fl-deep-red') : undefined });
  c.text(doc.headline, { size: 26 });
  if (doc.triggers.length) {
    c.text(t('adv.whytitle'), { size: 26, weight: 700, head: true });
    doc.triggers.forEach((tr) => c.text(`• ${tr}`, { size: 22, gap: 2 }));
    c.y += 10;
  }
  for (const card of doc.cards) {
    c.ensure(120);
    c.text(card.title, { size: 28, weight: 700, head: true, gap: 4 });
    for (const item of card.items) {
      c.text(`• ${item.text}`, { size: 22, gap: 2 });
      if (item.why) c.text(`${t('adv.because')}: ${item.why}`, { size: 19, muted: true, x: M + 30, width: W - 2 * M - 30, gap: 4 });
    }
    c.y += 12;
  }
  c.ensure(200);
  doc.guardrails.forEach((g) => c.text(g, { size: 20, weight: 600, gap: 4 }));
  await c.save('fireledger-advisory.pdf');
}
