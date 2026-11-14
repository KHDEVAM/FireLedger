import ar from './ar';
import en from './en';
import fr from './fr';

export type Lang = 'en' | 'fr' | 'ar';

/** Add a language: create `<code>.ts` with the same keys as en.ts and register it here. */
const dictionaries: Record<Lang, Record<string, string>> = { en, fr, ar };
// ar-MA keeps Western digits, as used in Morocco and in the CSV exports
const locales: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR', ar: 'ar-MA' };

let lang: Lang = 'en';

export const languages = Object.keys(dictionaries) as Lang[];
export const getLang = (): Lang => lang;
export const isLang = (v: string | null): v is Lang => !!v && v in dictionaries;

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = dictionaries[lang][key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}

export async function setLang(next: Lang): Promise<void> {
  lang = next;
  const root = document.documentElement;
  root.lang = next;
  root.dir = next === 'ar' ? 'rtl' : 'ltr';
  if (next === 'ar') {
    // Arabic typeface is only loaded when needed
    await Promise.all([import('@fontsource/cairo/arabic-400.css'), import('@fontsource/cairo/arabic-700.css')]);
  }
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
}

export function monthName(month: number, style: 'long' | 'short' | 'narrow' = 'short'): string {
  return new Intl.DateTimeFormat(locales[lang], { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, 1)));
}

export function fmt(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const digits = Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0;
  return new Intl.NumberFormat(locales[lang], { maximumFractionDigits: digits }).format(value);
}
