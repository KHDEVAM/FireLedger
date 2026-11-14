/** Color access. Components never hard-code hex values; they read the brand tokens. */

export function tok(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const fonts = {
  head: () => tok('--font-head'),
  body: () => tok('--font-body'),
};

export const rampColors = (): string[] => [1, 2, 3, 4, 5, 6, 7].map((i) => tok(`--fl-ramp-${i}`));
export const zeroColor = (): string => tok('--fl-ramp-0');
export const divergingColors = (): string[] => [1, 2, 3, 4, 5, 6, 7].map((i) => tok(`--fl-div-${i}`));
export const ageColors = (): string[] => [1, 2, 3, 4].map((i) => tok(`--fl-age-${i}`));

/** Anomaly class limits in percent vs the baseline median (7 classes). */
export const ANOMALY_LIMITS = [-67, -40, -15, 25, 100, 200];

export interface CountScale {
  breaks: number[];
  color: (v: number) => string;
}

/** Quantile classes of the non-zero values; zero gets the "no activity" color. */
export function countScale(values: number[]): CountScale {
  const colors = rampColors();
  const zero = zeroColor();
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  const breaks: number[] = [];
  if (v.length) {
    for (let i = 1; i < colors.length; i++) {
      const b = v[Math.min(v.length - 1, Math.floor((i / colors.length) * v.length))];
      if (!breaks.length || b > breaks[breaks.length - 1]) breaks.push(b);
    }
  }
  return {
    breaks,
    color: (x: number) => {
      if (!(x > 0)) return zero;
      let k = 0;
      while (k < breaks.length && x >= breaks[k]) k++;
      // spread the classes over the whole ramp when there are fewer than 7
      const idx = breaks.length ? Math.round((k / breaks.length) * (colors.length - 1)) : 2;
      return colors[idx];
    },
  };
}

export function anomalyColor(pct: number): string {
  const colors = divergingColors();
  let k = 0;
  while (k < ANOMALY_LIMITS.length && pct >= ANOMALY_LIMITS[k]) k++;
  return colors[k];
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text color with the better contrast on the given fill. */
export function textOn(fill: string): string {
  const l = luminance(fill);
  const dark = luminance(tok('--cell-text-dark'));
  const light = luminance(tok('--cell-text-light'));
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast(l, dark) >= contrast(l, light) ? tok('--cell-text-dark') : tok('--cell-text-light');
}
