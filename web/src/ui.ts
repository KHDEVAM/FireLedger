const tooltip = () => document.getElementById('tooltip') as HTMLElement;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Tooltip next to an element; first line is the title. */
export function showTooltip(anchor: Element, lines: string[]): void {
  const tip = tooltip();
  tip.innerHTML = lines.map((l, i) => (i === 0 ? `<strong>${escapeHtml(l)}</strong>` : `<span>${escapeHtml(l)}</span><br>`)).join('');
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTooltip(): void {
  tooltip().hidden = true;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

export function setStatus(id: string, text: string, kind: 'info' | 'warn' | 'danger' = 'info'): void {
  const el = $(id);
  el.textContent = text;
  if (el.classList.contains('banner')) el.className = `banner ${kind}`;
}
