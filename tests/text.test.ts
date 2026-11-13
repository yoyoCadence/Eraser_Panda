import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules';
import { buildRules, DEFAULT_SETTINGS, parseList, sanitizeSettings } from '../src/core/settings';
import { decodeText, textHandler } from '../src/formats/text/handler';

const ctx = { rules: [...DEFAULT_RULES] };
const enc = (s: string) => new TextEncoder().encode(s);

describe('text handler', () => {
  it('removes labels per line and preserves line endings and BOM', async () => {
    const input = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Title,Confidential\r\nok line\r\n機密,x\n')]);
    const scan = await textHandler.scan(input, ctx);
    expect(scan.findings.map((f) => [f.matchText, f.where])).toEqual([
      ['Confidential', '第 1 行'],
      ['機密', '第 3 行'],
    ]);
    const out = await textHandler.apply(input, ctx, new Set(scan.findings.map((f) => f.id)));
    expect(Array.from(out.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(out.subarray(3))).toBe('Title\r\nok line\r\nx\n');
  });

  it('honours exceptions', async () => {
    const input = enc('Secret A\nSecret B\n');
    const scan = await textHandler.scan(input, ctx);
    const out = await textHandler.apply(input, ctx, new Set([scan.findings[1]!.id]));
    expect(new TextDecoder().decode(out)).toBe('Secret A\nB\n');
  });

  it('decodes Big5 (Excel CSV on Traditional Chinese Windows) and warns about UTF-8 output', async () => {
    // "機密" in Big5
    const big5 = new Uint8Array([0xbe, 0xf7, 0xb1, 0x4b]);
    expect(decodeText(big5)).toMatchObject({ text: '機密', encoding: 'big5' });
    const scan = await textHandler.scan(big5, ctx);
    expect(scan.findings).toHaveLength(1);
    expect(scan.warnings[0]).toMatch(/BIG5/);
  });
});

describe('settings', () => {
  it('builds rules from languages, disabled ids and custom entries', () => {
    const s = { ...structuredClone(DEFAULT_SETTINGS), customWords: ['ACME Corp'], customRegex: ['DOC-\\d+'] };
    s.languages.ja = false;
    s.disabledRuleIds = ['en:sensitive'];
    const rules = buildRules(s);
    expect(rules.some((r) => r.id.startsWith('ja:'))).toBe(false);
    expect(rules.some((r) => r.id === 'en:sensitive')).toBe(false);
    expect(rules.filter((r) => r.id.startsWith('user:')).map((r) => r.pattern)).toEqual(['ACME Corp', 'DOC-\\d+']);
  });

  it('sanitizes malformed input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ customWords: ['a', 1, ' a ', ''], languages: { en: 'no' } }).customWords).toEqual(['a']);
  });

  it('parses lists', () => {
    expect(parseList('ACME, 艾克米、Apollo\n\nACME', true)).toEqual(['ACME', '艾克米', 'Apollo']);
    expect(parseList('a,b\nc', false)).toEqual(['a,b', 'c']);
  });
});
