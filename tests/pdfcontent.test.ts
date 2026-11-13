import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { compileRules } from '../src/core/matcher';
import { DEFAULT_RULES } from '../src/core/rules';
import { parseCMap } from '../src/formats/pdf/content/fonts';
import { interpretAll } from '../src/formats/pdf/content/textScan';
import { parseContent } from '../src/formats/pdf/content/lexer';
import { pdfHandler } from '../src/formats/pdf/handler';
import { streamBytes } from '../src/formats/pdf/pdfdoc';
import { rawScan } from '../src/verify/raw';

const ctx = { rules: [...DEFAULT_RULES] };
const compiled = compileRules(DEFAULT_RULES);

/** Two pages exercising the content-stream constructs that real generators use. */
async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const c = doc.context;
  const font = c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const header = c.register(
    c.flateStream('BT /F1 9 Tf 50 810 Td (ACME | Internal Use Only) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 595, 842],
      Resources: { Font: { F1: font } },
    }),
  );
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([595, 842]);
    const content = [
      '% a comment that must survive verbatim',
      'q /Artifact <</Type /Pagination /Subtype /Watermark>> BDC BT /F1 40 Tf 1 0 0 1 100 400 Tm (CONFIDENTIAL) Tj ET EMC Q',
      'BT /F1 12 Tf 72 700 Td [(This is ) -10 (Con) -20 (fidential) 10 ( data.)] TJ ET',
      'BT /F1 12 Tf 14 TL 72 680 Td 1 Tc 110 Tz (Plain line) Tj (Top Secret) \' 2 0.5 (Not Secret?) " ET',
      'BI /W 2 /H 1 /CS /G /BPC 8 ID \u0000ÿ EI',
      '/X1 Do',
    ].join('\n');
    page.node.set(PDFName.of('Contents'), c.register(c.flateStream(content)));
    page.node.set(PDFName.of('Resources'), c.obj({ Font: { F1: font }, XObject: { X1: header } }));
  }
  return doc.save({ useObjectStreams: false });
}

describe('content-stream lexer', () => {
  it('keeps exact byte ranges and parses strings, arrays, dicts and inline images', () => {
    const src = new TextEncoder().encode('q 1 0 0 1 5 5 cm BT /F1 12 Tf [(a\\)b) -5 <4142>] TJ ET /P <</MCID 3>> BDC EMC BI /W 1 ID xyz EI Q');
    const ins = parseContent(src);
    expect(ins.map((i) => i.op)).toEqual(['q', 'cm', 'BT', 'Tf', 'TJ', 'ET', 'BDC', 'EMC', 'BI', 'Q']);
    const tj = ins[4]!;
    expect(new TextDecoder().decode(src.subarray(tj.start, tj.end))).toBe('[(a\\)b) -5 <4142>] TJ');
    expect(tj.args[0]).toMatchObject({ t: 'arr' });
    const arr = (tj.args[0] as { v: Array<{ t: string; v: unknown }> }).v;
    expect(new TextDecoder().decode(arr[0]!.v as Uint8Array)).toBe('a)b');
    expect(new TextDecoder().decode(arr[2]!.v as Uint8Array)).toBe('AB');
  });
});

describe('ToUnicode CMap parsing', () => {
  it('handles bfchar, bfrange with offsets and arrays, and ligatures', () => {
    const cmap = parseCMap(`1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <0020> <0010> <00660069> endbfchar
      2 beginbfrange <0024> <0026> <0041> <0030> <0031> [<6A5F> <5BC6>] endbfrange`);
    expect(cmap.uni.get(3)).toBe(' ');
    expect(cmap.uni.get(0x10)).toBe('fi');
    expect([0x24, 0x25, 0x26].map((c) => cmap.uni.get(c)).join('')).toBe('ABC');
    expect(cmap.uni.get(0x30)! + cmap.uni.get(0x31)!).toBe('機密');
    expect(cmap.ranges[0]!.len).toBe(2);
  });
});

describe('PDF page text', () => {
  it('finds labels across TJ kerning, \' and " operators, marked-content watermarks and shared forms', async () => {
    const { findings } = await pdfHandler.scan(await makePdf(), ctx);
    const text = findings.filter((f) => f.kind === 'text' || f.kind === 'watermark');
    const p1 = text.filter((f) => f.page === 1).map((f) => [f.matchText, f.location]);
    expect(p1).toEqual(
      expect.arrayContaining([
        ['CONFIDENTIAL', 'watermark'],
        ['Confidential', 'body'],
        ['Top Secret', 'body'],
        ['Secret', 'body'],
        ['Internal Use Only', 'header'],
      ]),
    );
    // the shared header form is reported once, not once per page
    expect(text.filter((f) => f.matchText === 'Internal Use Only')).toHaveLength(1);
    expect(text.find((f) => f.matchText === 'Internal Use Only')!.note).toMatch(/2 頁/);
    // every text finding can be highlighted
    for (const f of text) expect(f.rects?.[0]?.w).toBeGreaterThan(0);
  });

  it('removes glyphs, keeps following text in place, keeps untouched bytes verbatim', async () => {
    const input = await makePdf();
    const scan = await pdfHandler.scan(input, ctx);
    const out = await pdfHandler.apply(input, ctx, new Set(scan.findings.map((f) => f.id)));
    expect((await pdfHandler.scan(out, ctx)).findings).toEqual([]);
    expect(rawScan('pdf', out, compiled)).toEqual([]);

    const before = await PDFDocument.load(input);
    const after = await PDFDocument.load(out);
    /** user-space origin of the first glyph `ch` inside a page-1 run whose text contains `within` */
    const glyphAt = (d: PDFDocument, within: string, ch: string) => {
      for (const r of interpretAll(d).runs) {
        const t = r.glyphs.map((g) => g.text).join('');
        if (r.page !== 1 || !t.includes(within)) continue;
        const k = r.glyphs.findIndex((g, i) => g.text === ch && t.slice(i).startsWith(within.slice(within.indexOf(ch))));
        if (k >= 0) return r.quads[k]![0]!;
      }
      throw new Error(`glyph ${ch} in ${within} not found`);
    };
    for (const [within, ch] of [
      ['data.', 'd'], // after the removed "Confidential " (TJ with kerning)
      ['Plain line', 'P'],
      ['?', '?'], // after the removed "Secret" in the " operator
    ] as const) {
      const [x0, y0] = glyphAt(before, within, ch);
      const [x1, y1] = glyphAt(after, within, ch);
      expect(Math.abs(x1 - x0), `${within} x`).toBeLessThan(0.01);
      expect(Math.abs(y1 - y0), `${within} y`).toBeLessThan(0.01);
    }

    const page = after.getPage(0).node.Contents();
    const content = new TextDecoder('latin1').decode(streamBytes(page instanceof PDFRawStream ? page : after.context.lookup(page as never)));
    expect(content).toMatch(/^% a comment that must survive verbatim/);
    expect(content).toMatch(/BI \/W 2 \/H 1 \/CS \/G \/BPC 8 ID/);
  });

  it('honours per-occurrence exceptions inside one line', async () => {
    const input = await makePdf();
    const scan = await pdfHandler.scan(input, ctx);
    const keep = scan.findings.find((f) => f.page === 1 && f.matchText === 'Top Secret')!;
    const out = await pdfHandler.apply(input, ctx, new Set(scan.findings.filter((f) => f.id !== keep.id).map((f) => f.id)));
    const left = (await pdfHandler.scan(out, ctx)).findings.map((f) => `${f.page}:${f.matchText}`);
    expect(left).toEqual(['1:Top Secret']);
  });
});
