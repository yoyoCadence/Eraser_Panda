import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules';
import { pageList, pagesLabel } from '../src/core/pages';
import type { Region, ScanContext } from '../src/core/types';
import { interpretAll } from '../src/formats/pdf/content/textScan';
import { pdfHandler } from '../src/formats/pdf/handler';
import { imageFingerprint } from '../src/formats/pdf/images';
import { denormRect, normRect, streamBytes } from '../src/formats/pdf/pdfdoc';

const base: ScanContext = { rules: [...DEFAULT_RULES] };
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

/**
 * Three 600×800 pages, each with, in the top band (y 720–800):
 *   TOPLEFT text, a blue vector box, a clipping path, a stamp annotation, an image (same XObject on every page),
 *   a shared header form (with a nested form) drawn on every page;
 * plus a horizontal rule at y = 715 crossing the page and body text in the middle.
 */
async function makePdf(pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const c = doc.context;
  const font = c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const img = c.register(c.flateStream(new Uint8Array([0, 255, 255, 0]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const nested = c.register(c.flateStream('BT /F1 9 Tf 300 780 Td (NESTED) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: { F1: font } } }));
  const header = c.register(
    c.flateStream('BT /F1 9 Tf 200 785 Td (Confidential) Tj ET q 1 0 0 1 0 -20 cm /N1 Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 600, 800],
      Resources: { Font: { F1: font }, XObject: { N1: nested } },
    }),
  );
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([600, 800]);
    const content = [
      'BT /F1 12 Tf 40 760 Td (TOPLEFT) Tj ET',
      '0 0 1 rg 40 730 50 20 re f',
      'q 40 700 100 100 re W n 0 g Q',
      '0 G 0 715 m 600 715 l S',
      'q 60 0 0 30 500 750 cm /Im1 Do Q',
      '/Hd Do',
      'BT /F1 12 Tf 40 400 Td (Body text stays) Tj ET',
    ].join('\n');
    page.node.set(PDFName.of('Contents'), c.register(c.flateStream(content)));
    page.node.set(PDFName.of('Resources'), c.obj({ Font: { F1: font }, XObject: { Im1: img, Hd: header } }));
    const stamp = c.register(c.obj({ Type: 'Annot', Subtype: 'Stamp', Name: 'Approved', Rect: [45, 735, 85, 745] }));
    page.node.set(PDFName.of('Annots'), c.obj([stamp]));
  }
  return doc.save({ useObjectStreams: false });
}

const TOP_BAND = { x: 0, y: 0, w: 1, h: 0.1 }; // user space y 720..800

async function textByPage(bytes: Uint8Array): Promise<Map<number, string>> {
  const doc = await PDFDocument.load(bytes);
  const res = interpretAll(doc);
  const out = new Map<number, string>();
  // shared forms are interpreted once: attribute their text to every page that draws them
  for (const r of res.runs) {
    const pages = r.src.kind === 'form' ? [...(res.formUses.get(r.src.key) ?? [r.page])] : [r.page];
    for (const p of pages) out.set(p, `${out.get(p) ?? ''} ${r.glyphs.map((g) => g.text).join('')}`);
  }
  return out;
}

async function run(input: Uint8Array, regions: Region[]) {
  const ctx = { ...base, regions };
  const scan = await pdfHandler.scan(input, ctx);
  const ids = new Set(scan.findings.filter((f) => f.kind === 'region').map((f) => f.id));
  const out = await pdfHandler.apply(input, ctx, ids);
  return { scan, out, rescan: await pdfHandler.scan(out, ctx) };
}

describe('page lists', () => {
  it('compacts ranges', () => {
    expect(pageList([5, 1, 2, 3, 7, 8, 2])).toBe('1–3、5、7–8');
    expect(pagesLabel([86, 87])).toBe('第 86–87 頁');
    expect(pagesLabel([1, 3, 5, 7, 9, 11, 13, 15], 3)).toBe('第 1、3、5 等 頁');
  });
});

describe('normalised ↔ user-space rectangles', () => {
  it('round-trips on rotated pages', async () => {
    const doc = await PDFDocument.create();
    for (const rot of [0, 90, 180, 270]) {
      const page = doc.addPage([600, 800]);
      page.setRotation({ type: 'degrees', angle: rot } as never);
    }
    const r: [number, number, number, number] = [40, 700, 160, 760];
    for (let i = 0; i < 4; i++) {
      const back = denormRect(doc, i, normRect(doc, i, r));
      back.forEach((v, k) => expect(v).toBeCloseTo(r[k]!, 6));
    }
  });
});

describe('PDF removal regions', () => {
  it('removes text, images, vector graphics and annotations inside the box on the chosen pages only', async () => {
    const input = await makePdf();
    const { scan, out, rescan } = await run(input, [{ id: 'r1', rect: TOP_BAND, from: 1, to: 2 }]);
    const st = scan.regionStats!.r1!;
    expect(st).toMatchObject({ text: 14, images: 2, paths: 2, annots: 2, partial: 0, pages: 2 });
    expect(st.shared).toBe(2); // header form + its nested form are also drawn on page 3 → kept
    expect(st.sample).toContain('TOPLEFT');
    const f = scan.findings.find((x) => x.id === 'region:r1')!;
    expect(f).toMatchObject({ kind: 'region', location: 'region', removable: true, defaultSelected: true, page: 1 });
    expect(f.where).toBe('第 1–2 頁・框選區域');
    expect(f.note).toMatch(/共用物件/);

    const text = await textByPage(out);
    expect(text.get(1)).not.toContain('TOPLEFT');
    expect(text.get(2)).not.toContain('TOPLEFT');
    expect(text.get(3)).toContain('TOPLEFT');
    for (const p of [1, 2, 3]) {
      expect(text.get(p)).toContain('Body text stays');
      expect(text.get(p)).toContain('Confidential'); // shared with page 3 → untouched
    }
    const after = await PDFDocument.load(out);
    const res = interpretAll(after, true);
    const boxes = (p: number) => res.paths.filter((x) => x.page === p && !x.clip && x.bbox[0] === 40 && x.bbox[2] === 90);
    expect(boxes(1)).toHaveLength(0);
    expect(boxes(3)).toHaveLength(1);
    // the rule crossing the box and the clipping path are kept on every page
    expect(res.paths.filter((x) => x.page === 1 && x.bbox[0] === 0 && x.bbox[2] === 600)).toHaveLength(1);
    const page1 = latin1(streamBytes(after.context.lookup(after.getPage(0).node.get(PDFName.of('Contents'))))!);
    expect(page1).toMatch(/700 100 100 re W n/);
    expect(res.images.filter((i) => i.page === 1)).toHaveLength(0);
    expect(res.images.filter((i) => i.page === 3)).toHaveLength(1);
    expect(latin1(out)).toMatch(/\/Subtype\s*\/Image/); // still drawn on page 3
    expect(after.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(after.getPage(2).node.Annots()?.size()).toBe(1);
    // verification: nothing removable is left in the region
    expect(rescan.findings.some((x) => x.kind === 'region')).toBe(false);
    expect(rescan.regionStats!.r1).toMatchObject({ text: 0, images: 0, paths: 0, annots: 0 });
  });

  it('removes shared content (nested forms too) and the image data when the range covers every use', async () => {
    const input = await makePdf();
    const { scan, out } = await run(input, [{ id: 'all', rect: TOP_BAND, from: 1, to: 3 }]);
    expect(scan.regionStats!.all).toMatchObject({ shared: 0, images: 3 });
    const text = await textByPage(out);
    for (const p of [1, 2, 3]) {
      expect(text.get(p) ?? '').not.toMatch(/TOPLEFT|Confidential|NESTED/);
      expect(text.get(p)).toContain('Body text stays');
    }
    expect(latin1(out)).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it('keeps following text in place when glyphs are cut out of a line', async () => {
    const doc = await PDFDocument.create();
    const c = doc.context;
    const font = c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Contents'), c.register(c.flateStream('BT /F1 20 Tf 50 400 Td (ACME Ltd quarterly plan) Tj ET')));
    page.node.set(PDFName.of('Resources'), c.obj({ Font: { F1: font } }));
    const input = await doc.save();
    const x0 = (b: Uint8Array) =>
      PDFDocument.load(b).then((d) => {
        const r = interpretAll(d).runs.find((x) => x.glyphs.some((g) => g.text === 'q'))!;
        return r.quads[r.glyphs.findIndex((g) => g.text === 'q')]![0]![0];
      });
    // box over "ACME Ltd" only (x 50..~140 → 0.08..0.24)
    const { out } = await run(input, [{ id: 'a', rect: { x: 0.08, y: 0.45, w: 0.16, h: 0.1 }, from: 1, to: 1 }]);
    const t = (await textByPage(out)).get(1)!;
    expect(t).not.toContain('ACME');
    expect(t).toContain('quarterly plan');
    expect(Math.abs((await x0(out)) - (await x0(input)))).toBeLessThan(0.01);
  });

  it('leaves images that are only partly inside, and reports them', async () => {
    const { scan, out } = await run(await makePdf(1), [{ id: 'p', rect: { x: 0.86, y: 0, w: 0.02, h: 0.1 }, from: 1, to: 1 }]);
    expect(scan.regionStats!.p).toMatchObject({ images: 0, partial: 1 });
    expect(scan.findings.some((f) => f.kind === 'region')).toBe(false); // nothing removable → no finding
    expect(latin1(out)).toMatch(/\/Subtype\s*\/Image/);
  });

  it('an empty region yields stats but no finding; ids are stable; ranges are clamped', async () => {
    const input = await makePdf(2);
    const ctx = { ...base, regions: [{ id: 'e', rect: { x: 0.4, y: 0.6, w: 0.2, h: 0.1 }, from: 1, to: 9 }, { id: 'k', rect: TOP_BAND, from: 2, to: 1 }] };
    const a = await pdfHandler.scan(input, ctx);
    const b = await pdfHandler.scan(input, ctx);
    expect(a.regionStats!.e).toMatchObject({ text: 0, images: 0, paths: 0, annots: 0, pages: 2 });
    expect(a.findings.filter((f) => f.kind === 'region').map((f) => f.id)).toEqual(['region:k']);
    expect(a.findings.find((f) => f.id === 'region:k')!.where).toBe('第 1–2 頁・框選區域');
    expect(b.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id));
  });

  it('an unselected region changes nothing', async () => {
    const input = await makePdf(1);
    const ctx = { ...base, regions: [{ id: 'r', rect: TOP_BAND, from: 1, to: 1 }] };
    const out = await pdfHandler.apply(input, ctx, new Set());
    expect((await textByPage(out)).get(1)).toContain('TOPLEFT');
  });
});

describe('vector path tracking', () => {
  it('is off unless regions are drawn, and handles paths with a huge number of points', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const pts = Array.from({ length: 200_000 }, (_, i) => `${(i % 500) + 10} ${(i % 700) + 10} l`).join(' ');
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`10 10 m ${pts} S`)));
    const d = await PDFDocument.load(await doc.save());
    expect(interpretAll(d).paths).toHaveLength(0);
    const tracked = interpretAll(d, true).paths;
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.bbox).toEqual([10, 10, 509, 709]);
  });
});

describe('findings drawn on many pages', () => {
  it('a shared header form is highlighted on every page it appears on, nested forms included', async () => {
    const { findings } = await pdfHandler.scan(await makePdf(), base);
    const hdr = findings.find((f) => f.matchText === 'Confidential')!;
    expect(hdr.where).toBe('第 1–3 頁・頁首');
    expect(hdr.highlights!.map((h) => h.page)).toEqual([1, 2, 3]);
    for (const h of hdr.highlights!) expect(h.rects[0]!.y).toBeLessThan(0.03);
  });

  it('the same logo embedded once per page is one finding, highlighted on every page', async () => {
    const doc = await PDFDocument.create();
    const c = doc.context;
    for (let p = 0; p < 3; p++) {
      // a separate XObject per page with identical bytes (typical of some generators)
      const img = c.register(c.flateStream(new Uint8Array([0, 128, 255, 64, 32, 16]), { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
      const page = doc.addPage([600, 800]);
      page.node.set(PDFName.of('Contents'), c.register(c.flateStream(`q 60 0 0 30 ${p === 1 ? 480 : 500} 750 cm /L Do Q q 60 0 0 30 40 750 cm /L Do Q`)));
      page.node.set(PDFName.of('Resources'), c.obj({ XObject: { L: img } }));
    }
    const input = await doc.save();
    const { findings } = await pdfHandler.scan(input, base);
    const logos = findings.filter((f) => f.kind === 'image');
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ confidence: 'high', where: '第 1–3 頁・頁首圖片' });
    expect(logos[0]!.highlights!.map((h) => [h.page, h.rects.length])).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    // page 2's right logo sits elsewhere — its own position is highlighted
    expect(logos[0]!.highlights![1]!.rects.some((r) => Math.abs(r.x - 0.8) < 0.001)).toBe(true);
    const out = await pdfHandler.apply(input, base, new Set([logos[0]!.id]));
    expect(latin1(out)).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it('images with the same pixel bytes but a different mask are NOT the same logo', async () => {
    const doc = await PDFDocument.create();
    const c = doc.context;
    const pixels = new Uint8Array([10, 10, 10, 10, 10, 10]); // a flat swatch: only the mask gives it a shape
    const mask = (bits: number[]) => c.register(c.flateStream(new Uint8Array(bits), { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    const image = (m: ReturnType<typeof mask>) =>
      c.register(c.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8, SMask: m }));
    const tick = image(mask([255, 0, 255, 0, 255, 0]));
    const cross = image(mask([0, 255, 0, 255, 0, 255]));
    const tickCopy = image(mask([255, 0, 255, 0, 255, 0])); // separate objects, identical content → same logo
    expect(imageFingerprint(doc, tick)).not.toBe(imageFingerprint(doc, cross));
    expect(imageFingerprint(doc, tick)).toBe(imageFingerprint(doc, tickCopy));
    for (const [p, img] of [tick, cross, tickCopy].entries()) {
      const page = doc.addPage([600, 800]);
      page.node.set(PDFName.of('Contents'), c.register(c.flateStream(`q 60 0 0 30 ${40 + p * 200} 750 cm /I Do Q`)));
      page.node.set(PDFName.of('Resources'), c.obj({ XObject: { I: img } }));
    }
    const { findings } = await pdfHandler.scan(await doc.save(), base);
    const logos = findings.filter((f) => f.kind === 'image').map((f) => [f.where, f.highlights!.map((h) => h.page)]);
    expect(logos).toEqual(
      expect.arrayContaining([
        ['第 1、3 頁・頁首圖片', [1, 3]],
        ['第 2 頁・頁首圖片', [2]],
      ]),
    );
    expect(logos).toHaveLength(2);
  });
});
