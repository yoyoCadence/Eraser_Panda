import { normalize, normalizePattern, type Normalized } from './normalize';
import type { Rule } from './types';

/** A hit in ORIGINAL text coordinates. */
export interface Hit {
  start: number;
  end: number;
  ruleId: string;
  /** original text slice */
  text: string;
}

interface CompiledRule {
  rule: Rule;
  re: RegExp;
  fold: boolean;
}

export interface CompiledRules {
  list: CompiledRule[];
  /** rules that failed to compile (bad user regex) with the error message */
  errors: Array<{ ruleId: string; message: string }>;
}

// "Word" characters for whole-word matching. CJK is intentionally excluded: CJK text has no spaces, so
// "本文件為Confidential" must still match "Confidential", and 機密 must match inside 公司機密文件.
// "_" is NOT a word character here: labels appear in file names and identifiers such as
// "ACME_Confidential_2024.docx" or "confidential_logo", where the underscore is a separator.
const WORDISH = String.raw`[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}]`;
const WORDISH_RE = new RegExp(`^${WORDISH}$`, 'u');
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SYNTAX = /[\\^$.*+?()[\]{}|/]/;

function literalToSource(p: string): string {
  const chars = Array.from(p);
  let src = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === ' ') {
      // Text is whitespace-collapsed, and PDF extraction often loses inter-word spaces entirely.
      src += ' ?';
      continue;
    }
    src += SYNTAX.test(c) ? `\\${c}` : c;
    // CJK labels are frequently letter-spaced: "機 密", "機　密".
    const n = chars[i + 1];
    if (n && n !== ' ' && CJK_RE.test(c) && CJK_RE.test(n)) src += ' ?';
  }
  return src;
}

export function compileRules(rules: readonly Rule[]): CompiledRules {
  const list: CompiledRule[] = [];
  const errors: CompiledRules['errors'] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;
    const fold = !rule.caseSensitive;
    try {
      let src: string;
      let wbStart = false;
      let wbEnd = false;
      if (rule.isRegex) {
        src = rule.pattern;
        wbStart = wbEnd = rule.wholeWord;
      } else {
        const p = normalizePattern(rule.pattern, fold);
        if (!p) continue;
        src = literalToSource(p);
        const chars = Array.from(p);
        wbStart = rule.wholeWord && WORDISH_RE.test(chars[0]!);
        wbEnd = rule.wholeWord && WORDISH_RE.test(chars[chars.length - 1]!);
      }
      if (wbStart) src = `(?<!${WORDISH})(?:${src})`;
      if (wbEnd) src = `(?:${src})(?!${WORDISH})`;
      const re = new RegExp(src, fold ? 'giu' : 'gu');
      list.push({ rule, re, fold });
    } catch (e) {
      errors.push({ ruleId: rule.id, message: (e as Error).message });
    }
  }
  return { list, errors };
}

/**
 * Find all rule hits in `text`. Overlapping hits are merged into their union (attributed to the longest
 * contributing rule), so "Strictly Confidential" wins over "Confidential" and "公司機密" + "機密文件" in
 * "公司機密文件" removes the whole phrase instead of leaving "文件" behind. Returned hits never overlap.
 */
export function findHits(text: string, compiled: CompiledRules): Hit[] {
  if (!text || compiled.list.length === 0) return [];
  const norms: { folded?: Normalized; exact?: Normalized } = {};
  const getNorm = (fold: boolean) => (fold ? (norms.folded ??= normalize(text, true)) : (norms.exact ??= normalize(text, false)));

  const raw: Hit[] = [];
  for (const { rule, re, fold } of compiled.list) {
    const n = getNorm(fold);
    if (!n.text) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(n.text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const a = m.index;
      const b = a + m[0].length;
      const start = n.start[a]!;
      const end = n.end[b - 1]!;
      raw.push({ start, end, ruleId: rule.id, text: text.slice(start, end) });
    }
  }
  if (raw.length <= 1) return raw;

  raw.sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: Hit[] = [];
  let cur = { ...raw[0]!, best: raw[0]!.end - raw[0]!.start };
  for (let i = 1; i < raw.length; i++) {
    const h = raw[i]!;
    if (h.start < cur.end) {
      const len = h.end - h.start;
      if (len > cur.best) {
        cur.best = len;
        cur.ruleId = h.ruleId;
      }
      cur.end = Math.max(cur.end, h.end);
    } else {
      merged.push(finish(cur));
      cur = { ...h, best: h.end - h.start };
    }
  }
  merged.push(finish(cur));
  return merged;

  function finish(h: Hit & { best: number }): Hit {
    return { start: h.start, end: h.end, ruleId: h.ruleId, text: text.slice(h.start, h.end) };
  }
}
