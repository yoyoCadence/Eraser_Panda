import { DEFAULT_RULES, userRule } from './rules';
import type { Rule } from './types';

export type LangKey = 'en' | 'zh-Hant' | 'zh-Hans' | 'ja' | 'ko';

export const LANG_LABEL: Record<LangKey, string> = {
  en: '英文',
  'zh-Hant': '繁體中文',
  'zh-Hans': '簡體中文',
  ja: '日文',
  ko: '韓文',
};

export interface Settings {
  version: 1;
  languages: Record<LangKey, boolean>;
  /** Default rules the user switched off individually. */
  disabledRuleIds: string[];
  /** Extra literal keywords: company names, project code names … (case-insensitive, whole word). */
  customWords: string[];
  /** Extra regular expressions (advanced). */
  customRegex: string[];
  /** User-supplied logo samples: perceptual hash + a small thumbnail for display. */
  logoSamples: Array<{ name: string; hash: string; thumb: string }>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  languages: { en: true, 'zh-Hant': true, 'zh-Hans': true, ja: true, ko: true },
  disabledRuleIds: [],
  customWords: [],
  customRegex: [],
  logoSamples: [],
};

const KEY = 'eraser-panda:settings:v1';

/** Browser storage may be unavailable (private mode, file:// policies) — always fall back to defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings live for this session only */
  }
}

/** Accept settings from storage or an imported file; ignore anything malformed. */
export function sanitizeSettings(input: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return s;
  const o = input as Partial<Settings>;
  if (o.languages && typeof o.languages === 'object') {
    for (const k of Object.keys(s.languages) as LangKey[]) {
      if (typeof o.languages[k] === 'boolean') s.languages[k] = o.languages[k];
    }
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
  s.disabledRuleIds = strings(o.disabledRuleIds);
  s.customWords = [...new Set(strings(o.customWords))];
  s.customRegex = [...new Set(strings(o.customRegex))];
  if (Array.isArray(o.logoSamples)) {
    s.logoSamples = o.logoSamples
      .filter((x): x is Settings['logoSamples'][number] => !!x && typeof x.hash === 'string' && /^[0-9a-f]{16}@[\d.]+$/.test(x.hash) && typeof x.thumb === 'string' && x.thumb.startsWith('data:image/'))
      .map((x) => ({ name: String(x.name ?? 'logo').slice(0, 80), hash: x.hash, thumb: x.thumb }))
      .slice(0, 20);
  }
  return s;
}

export function buildRules(s: Settings): Rule[] {
  const disabled = new Set(s.disabledRuleIds);
  const rules: Rule[] = DEFAULT_RULES.filter((r) => s.languages[r.id.slice(0, r.id.indexOf(':')) as LangKey] !== false && !disabled.has(r.id));
  for (const w of s.customWords) rules.push(userRule(w, { category: 'company' }));
  for (const re of s.customRegex) rules.push(userRule(re, { isRegex: true, wholeWord: false }));
  return rules;
}

/** Parse a textarea: one entry per line (commas also split, except for regex). */
export function parseList(text: string, splitCommas: boolean): string[] {
  const parts = splitCommas ? text.split(/[\n,，、]/) : text.split('\n');
  return [...new Set(parts.map((x) => x.trim()).filter(Boolean))];
}
