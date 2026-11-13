import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/core/fileType';
import { DEFAULT_RULES } from '../src/core/rules';
import { parseContent } from '../src/formats/pdf/content/lexer';
import { docxHandler, xlsxHandler } from '../src/formats/ooxml/handler';
import { pdfHandler } from '../src/formats/pdf/handler';

const ctx = { rules: [...DEFAULT_RULES] };
const load = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/${n}`));

describe('robustness — bad input never crashes, it explains', () => {
  it('truncated Office file', async () => {
    const cut = load('sample.docx').slice(0, 4000);
    const det = detectFormat('x.docx', cut);
    if (det.ok) await expect(docxHandler.scan(cut, ctx)).rejects.toThrow(/損毀|ZIP|解析/);
    else expect(det.message).toMatch(/ZIP|不支援/);
  });

  it('zip that is not an Office document', () => {
    const det = detectFormat('x.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    expect(det.ok).toBe(false);
  });

  it('Office part with broken XML', async () => {
    const { unzipSync, zipSync, strToU8 } = await import('fflate');
    const p = unzipSync(load('sample.xlsx'));
    p['xl/comments/comment1.xml'] = strToU8('<comments><broken');
    await expect(xlsxHandler.scan(zipSync(p), ctx)).rejects.toThrow(/XML 解析失敗/);
  });

  it('owner-password (encrypted) PDF is refused with an actionable message', async () => {
    await expect(pdfHandler.scan(load('encrypted.pdf'), ctx)).rejects.toThrow(/加密.*列印/);
  });

  it('truncated PDF either scans partially or explains', async () => {
    const half = load('office.pdf').slice(0, 12000);
    try {
      const r = await pdfHandler.scan(half, ctx);
      expect(Array.isArray(r.findings)).toBe(true);
    } catch (e) {
      expect((e as Error).message).toMatch(/損毀|解析|加密/);
    }
  });

  it('malformed content stream does not throw', async () => {
    expect(() => parseContent(new TextEncoder().encode('BT /F1 12 Tf (unterminated Tj [ 1 2 << /a ET ] >> } ) Q Q Q'))).not.toThrow();
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('Q Q BT /F9 12 Tf (Secret) Tj ET BT /F1 12 Tf [(Con) /bogus (fidential)] TJ 1 0 0 cm /Missing Do ET')));
    const bytes = await doc.save();
    const r = await pdfHandler.scan(bytes, ctx);
    expect(r.findings.some((f) => f.matchText === 'Confidential')).toBe(true);
    const out = await pdfHandler.apply(bytes, ctx, new Set(r.findings.map((f) => f.id)));
    expect((await pdfHandler.scan(out, ctx)).findings.filter((f) => f.matchText === 'Confidential')).toEqual([]);
  });
});
