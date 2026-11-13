import { describe, expect, it } from 'vitest';
import { compileRules, findHits } from '../src/core/matcher';
import { normalize } from '../src/core/normalize';
import { DEFAULT_RULES, userRule } from '../src/core/rules';
import { cutPieces, matchSegments } from '../src/core/segments';

const defaults = compileRules(DEFAULT_RULES);
const texts = (s: string) => findHits(s, defaults).map((h) => h.text);

describe('normalize', () => {
  it('maps full-width, case and whitespace back to original offsets', () => {
    const n = normalize('Ａ　　Ｂ', true);
    expect(n.text).toBe('a b');
    expect(Array.from(n.start)).toEqual([0, 1, 3]);
    expect(Array.from(n.end)).toEqual([1, 3, 4]);
  });
  it('drops zero-width characters', () => {
    expect(normalize('Con​fi­dential', true).text).toBe('confidential');
  });
});

describe('findHits — default rules', () => {
  it('is case-insensitive and finds full-width text', () => {
    expect(texts('This is CONFIDENTIAL.')).toEqual(['CONFIDENTIAL']);
    expect(texts('ＣＯＮＦＩＤＥＮＴＩＡＬ')).toEqual(['ＣＯＮＦＩＤＥＮＴＩＡＬ']);
  });

  it('respects word boundaries for Latin words', () => {
    expect(texts('The Secretary said')).toEqual([]);
    expect(texts('trade-secret.')).toEqual(['secret']);
    expect(texts('Top Secret!')).toEqual(['Top Secret']);
    expect(texts('confidentiality agreement')).toEqual([]);
  });

  it('matches Latin labels glued to CJK text', () => {
    expect(texts('本文件為Confidential等級')).toEqual(['Confidential']);
  });

  it('prefers the longest phrase', () => {
    const hits = findHits('Strictly Confidential - page 2', defaults);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ text: 'Strictly Confidential', ruleId: 'en:strictly-confidential' });
  });

  it('tolerates lost or doubled spaces inside phrases', () => {
    expect(texts('StrictlyConfidential')).toEqual(['StrictlyConfidential']);
    expect(texts('Internal   Use   Only')).toEqual(['Internal   Use   Only']);
  });

  it('merges overlapping CJK hits into one span', () => {
    expect(texts('本文件為公司機密文件，請勿外傳')).toEqual(['公司機密文件', '請勿外傳']);
  });

  it('matches letter-spaced CJK labels', () => {
    expect(texts('機　密')).toEqual(['機　密']);
    expect(texts('極 機 密')).toEqual(['極 機 密']);
  });

  it('covers simplified Chinese, Japanese and Korean', () => {
    expect(texts('机密')).toEqual(['机密']);
    expect(texts('社外秘')).toEqual(['社外秘']);
    expect(texts('대외비')).toEqual(['대외비']);
  });

  it('does not match common words deliberately excluded', () => {
    expect(texts('Internal process. Private equity. 密碼')).toEqual([]);
  });

  it('includes characters hidden by zero-width joiners in the removed range', () => {
    const hits = findHits('A Confi​dential B', defaults);
    expect(hits[0]!.text).toBe('Confi​dential');
  });
});

describe('user rules', () => {
  it('supports company names and regex', () => {
    const c = compileRules([userRule('ACME Corp'), userRule('PRJ-\\d{4}', { isRegex: true })]);
    expect(findHits('acme corp ships PRJ-2024 and ＰＲＪ－２０２５', c).map((h) => h.text)).toEqual(['acme corp', 'PRJ-2024', 'ＰＲＪ－２０２５']);
  });
  it('reports invalid regex instead of throwing', () => {
    const c = compileRules([userRule('(', { isRegex: true })]);
    expect(c.list).toHaveLength(0);
    expect(c.errors).toHaveLength(1);
  });
  it('honours case sensitivity', () => {
    const c = compileRules([userRule('ACME', { caseSensitive: true })]);
    expect(findHits('acme ACME', c).map((h) => h.start)).toEqual([5]);
  });
  it('skips disabled rules', () => {
    expect(compileRules([userRule('x', { enabled: false })]).list).toHaveLength(0);
  });
});

describe('matchSegments / cutPieces', () => {
  it('maps a hit split across runs back to each run', () => {
    const segs = [{ text: 'Company ' }, { text: 'Confi' }, { text: 'dential' }, { text: ' — page 1' }];
    const [hit] = matchSegments(segs, defaults);
    expect(hit!.text).toBe('Company Confidential');
    expect(hit!.pieces).toEqual([
      { seg: 0, start: 0, end: 8 },
      { seg: 1, start: 0, end: 5 },
      { seg: 2, start: 0, end: 7 },
    ]);
    expect(cutPieces(segs.map((s) => s.text), hit!.pieces)).toEqual(['', '', '', ' — page 1']);
    expect(hit!.wholeUnit).toBe(false);
  });

  it('never includes virtual segments in removals', () => {
    const segs = [{ text: 'Strictly' }, { text: ' ', virtual: true }, { text: 'Confidential' }];
    const [hit] = matchSegments(segs, defaults);
    expect(hit!.pieces.map((p) => p.seg)).toEqual([0, 2]);
    expect(hit!.wholeUnit).toBe(true);
  });

  it('builds context around the hit', () => {
    const [hit] = matchSegments([{ text: 'This document is confidential and must not leave.' }], defaults);
    expect(hit!.context).toEqual({ before: 'This document is ', match: 'confidential', after: ' and must not leave.' });
  });

  it('flags label-only units as whole-unit', () => {
    const [hit] = matchSegments([{ text: '— CONFIDENTIAL —' }], defaults);
    expect(hit!.wholeUnit).toBe(true);
  });

  it('cuts multiple pieces in one segment', () => {
    expect(cutPieces(['a SECRET b SECRET c'], [{ seg: 0, start: 2, end: 8 }, { seg: 0, start: 11, end: 17 }])).toEqual(['a  b  c']);
  });
});

describe('rule ids', () => {
  it('are unique and stable', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(userRule('ACME').id).toBe(userRule('ACME').id);
  });
});
