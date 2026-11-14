/**
 * Randomised (seeded, reproducible) tests for the two places where an off-by-one silently corrupts output:
 *   1. mapping hits on joined text back onto arbitrarily split segments (Word runs, PDF glyph runs)
 *   2. rewriting PDF show operators: remaining glyphs must keep their exact positions
 */
import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { compileRules, findHits } from '../src/core/matcher';
import { DEFAULT_RULES } from '../src/core/rules';
import { cutPieces, joinSegments, matchSegments, tidyRange, type Segment } from '../src/core/segments';
import { interpretAll } from '../src/formats/pdf/content/textScan';
import { pdfHandler } from '../src/formats/pdf/handler';

const compiled = compileRules(DEFAULT_RULES);
const ctx = { rules: [...DEFAULT_RULES] };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 0x100000000;
  };
}

const WORDS = ['the', 'plan', 'Confidential', 'report', 'Secret', 'budget', 'Internal Use Only', 'for', 'board', 'Top Secret', 'data', 'Secretary', 'sensitive', 'Q3', '|', '-', '(Restricted)', '機密', '文件', '請勿外傳', '，', '。'];

function sentence(r: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]!);
  return out.join(r() < 0.5 ? ' ' : ' ');
}

describe('fuzz: cross-segment mapping', () => {
  it('cutting per segment equals cutting the joined text (500 random splits)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const text = sentence(r, 4 + Math.floor(r() * 10));
      // random split into segments, sometimes with virtual separators that are not part of the text
      const segs: Segment[] = [];
      let i = 0;
      while (i < text.length) {
        const len = 1 + Math.floor(r() * 6);
        segs.push({ text: text.slice(i, i + len) });
        i += len;
      }
      const hits = matchSegments(segs, compiled);
      const out = cutPieces(segs.map((s) => s.text), hits.flatMap((h) => h.pieces)).join('');
      // expected: cut the tidied ranges directly from the joined text
      const { joined } = joinSegments(segs);
      let expected = '';
      let pos = 0;
      let lastEnd = 0;
      for (const h of findHits(joined, compiled)) {
        let [cs, ce] = tidyRange(joined, h.start, h.end);
        cs = Math.max(cs, lastEnd);
        lastEnd = ce;
        expected += joined.slice(pos, cs);
        pos = ce;
      }
      expected += joined.slice(pos);
      expect(out, `seed ${seed}: ${JSON.stringify(text)}`).toBe(expected);
      expect(findHits(out, compiled).filter((h) => !/secretary/i.test(h.text)), `seed ${seed} residual`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** WinAnsi literal string (escaping), or a 2-byte Identity-H hex string for the CID font. */
function encode(text: string, cid: boolean): string {
  if (cid) {
    let h = '';
    for (const ch of text) h += ch.codePointAt(0)!.toString(16).padStart(4, '0');
    return `<${h}>`;
  }
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** Random TJ / Tj / ' sequence drawing `text`, with random kerning, Tc, Tw, Tz and line moves. */
function contentFor(r: () => number, lines: string[]): string {
  const ops: string[] = [];
  let y = 760;
  for (const line of lines) {
    const cid = /[^\x20-\x7e]/.test(line) || r() < 0.3;
    ops.push('BT', `/${cid ? 'C1' : 'F1'} ${8 + Math.floor(r() * 8)} Tf`, `${(r() * 2).toFixed(2)} Tc`, `${(r() * 3).toFixed(2)} Tw`, `${80 + Math.floor(r() * 40)} Tz`, `72 ${y} Td`);
    y -= 24;
    // split the line into random chunks drawn by random operators
    let i = 0;
    const chars = Array.from(line);
    const tj: string[] = [];
    const flush = () => {
      if (tj.length) ops.push(`[${tj.join(' ')}] TJ`);
      tj.length = 0;
    };
    while (i < chars.length) {
      const len = 1 + Math.floor(r() * 7);
      const chunk = chars.slice(i, i + len).join('');
      i += len;
      const mode = r();
      if (mode < 0.5) {
        tj.push(encode(chunk, cid));
        if (r() < 0.5) tj.push(String(Math.round((r() - 0.5) * 120)));
      } else {
        flush();
        ops.push(`${encode(chunk, cid)} Tj`);
      }
    }
    flush();
    ops.push('ET');
  }
  return ops.join('\n');
}

async function makePdf(content: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const c = doc.context;
  const helv = c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  // non-embedded CID font: Identity-H codes == Unicode code units, mapped by a ToUnicode CMap
  const cmap = c.register(
    c.flateStream(
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap end end',
    ),
  );
  const desc = c.register(c.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Test', CIDSystemInfo: { Registry: c.obj('Adobe'), Ordering: c.obj('Identity'), Supplement: 0 }, DW: 1000, W: [32, [250], 33, 126, 520] }));
  const cid = c.register(c.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Test', Encoding: 'Identity-H', DescendantFonts: [desc], ToUnicode: cmap }));
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of('Resources'), c.obj({ Font: { F1: helv, C1: cid } }));
  page.node.set(PDFName.of('Contents'), c.register(c.flateStream(content)));
  return doc.save({ useObjectStreams: false });
}

interface G {
  text: string;
  x: number;
  y: number;
}

async function glyphs(bytes: Uint8Array): Promise<G[]> {
  const doc = await PDFDocument.load(bytes);
  return interpretAll(doc).runs.flatMap((r) => r.glyphs.map((g, i) => ({ text: g.text, x: r.quads[i]![0]![0], y: r.quads[i]![0]![1] })));
}

describe('fuzz: PDF rewrite keeps every remaining glyph in place', () => {
  it('120 random pages (simple + CID fonts, TJ kerning, Tj, Tc/Tw/Tz)', async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 7919);
      const lines = Array.from({ length: 3 + Math.floor(r() * 4) }, () => sentence(r, 3 + Math.floor(r() * 7)));
      const input = await makePdf(contentFor(r, lines));
      const scan = await pdfHandler.scan(input, ctx);
      const out = await pdfHandler.apply(input, ctx, new Set(scan.findings.map((f) => f.id)));
      const rescan = await pdfHandler.scan(out, ctx);
      expect(rescan.findings.map((f) => f.matchText), `seed ${seed} residual`).toEqual([]);

      const before = await glyphs(input);
      const after = await glyphs(out);
      // every glyph left in the output must be an input glyph at the same position, in the same order
      let k = 0;
      for (const g of after) {
        while (k < before.length && !(before[k]!.text === g.text && Math.abs(before[k]!.x - g.x) < 0.01 && Math.abs(before[k]!.y - g.y) < 0.01)) k++;
        expect(k, `seed ${seed}: glyph ${JSON.stringify(g.text)} at ${g.x.toFixed(2)},${g.y.toFixed(2)} moved or appeared`).toBeLessThan(before.length);
        k++;
      }
      const hadHits = scan.findings.length > 0;
      if (hadHits) expect(after.length, `seed ${seed}`).toBeLessThan(before.length);
    }
  }, 120_000);
});
