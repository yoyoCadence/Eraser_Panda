import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileRules } from '../src/core/matcher';
import { DEFAULT_RULES } from '../src/core/rules';
import type { ScanContext } from '../src/core/types';
import { pdfHandler } from '../src/formats/pdf/handler';
import { rawScan } from '../src/verify/raw';

const ctx: ScanContext = { rules: [...DEFAULT_RULES] };
const compiled = compileRules(DEFAULT_RULES);
const load = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

let pypdf = false;
beforeAll(() => {
  mkdirSync('tests/output', { recursive: true });
  try {
    execFileSync('python3', ['-c', 'import pypdf'], { stdio: 'ignore' });
    pypdf = true;
  } catch {
    pypdf = false;
  }
});

/** Prove the output is a valid PDF by parsing it with an independent implementation. Returns its text. */
function pypdfText(bytes: Uint8Array, name: string): string | undefined {
  if (!pypdf) return undefined;
  const file = `tests/output/${name}`;
  writeFileSync(file, bytes);
  return execFileSync('python3', ['-c', 'import pypdf,sys; r=pypdf.PdfReader(sys.argv[1], strict=True); print(r.metadata); print("\\n".join(p.extract_text() for p in r.pages))', file]).toString();
}

async function cleanAll(bytes: Uint8Array) {
  const scan = await pdfHandler.scan(bytes, ctx);
  const out = await pdfHandler.apply(bytes, ctx, new Set(scan.findings.filter((f) => f.removable).map((f) => f.id)));
  return { scan, out, rescan: await pdfHandler.scan(out, ctx) };
}

describe('PDF metadata & structure (office.pdf)', () => {
  it('finds labels in Info, XMP, annotations, bookmarks and attachments', async () => {
    const { findings } = await pdfHandler.scan(load('office.pdf'), ctx);
    const ids = findings.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'info#Title:10-22',
        'info#identity:Author',
        'info#identity:Company',
        'info#key:Classification',
        'info#msip:3f5c2a1e-1111-4a2b-9c3d-0123456789ab',
        'catalog#xmp',
        'p1#annot:0',
        'p1#annot:1',
        'outline#o1:0-12',
        'catalog#attachment:0',
      ]),
    );
    expect(findings.some((f) => f.matchText.includes('Looks fine'))).toBe(false); // unrelated sticky note untouched
    const stamp = findings.find((f) => f.id === 'p1#annot:0')!;
    expect(stamp.rects![0]!.y).toBeLessThan(0.2); // stamp at the top of the page (top-left origin)
  });

  it('cleans everything and the output is a valid PDF without the labels in metadata', async () => {
    const { out, rescan } = await cleanAll(load('office.pdf'));
    expect(rescan.findings).toEqual([]);
    const raw = latin1(out);
    expect(raw).not.toMatch(/MSIP_Label|Classification|Jane Doe|ACME Corp|\/Stamp|original\.docx|Confidential appendix/);
    expect(raw).toMatch(/Introduction/); // unrelated bookmark kept
    const text = pypdfText(out, 'office_clean.pdf');
    if (text !== undefined) expect(text).toMatch(/The Secretary approved the budget/);
  });

  it('honours exceptions', async () => {
    const input = load('office.pdf');
    const { findings } = await pdfHandler.scan(input, ctx);
    const out = await pdfHandler.apply(input, ctx, new Set(findings.filter((f) => f.id !== 'p1#annot:0').map((f) => f.id)));
    const rescan = await pdfHandler.scan(out, ctx);
    expect(rescan.findings.map((f) => f.matchText)).toEqual(['Confidential 圖章']);
  });
});

describe('PDF page text (real generators)', () => {
  it('LibreOffice export: decodes subset TrueType + CJK fonts and removes every label', async () => {
    const { scan, out, rescan } = await cleanAll(load('office.pdf'));
    const text = scan.findings.filter((f) => f.kind === 'text').map((f) => `${f.location}:${f.matchText}`);
    expect(text).toEqual(
      expect.arrayContaining(['header:Confidential', 'body:STRICTLY CONFIDENTIAL', 'body:公司機密文件', 'body:請勿外傳', 'footer:Restricted', 'footer:Internal Use Only']),
    );
    expect(rescan.findings).toEqual([]);
    const t = pypdfText(out, 'office_text_clean.pdf');
    if (t !== undefined) {
      expect(t).not.toMatch(/Confidential|CONFIDENTIAL|Restricted|Top Secret|機密/);
      expect(t).toMatch(/The Secretary approved the budget/);
    }
  });

  it('reportlab: standard fonts, rotated watermark, glyph-by-glyph text, CID font with UniCNS-UCS2-H', async () => {
    const { scan, out, rescan } = await cleanAll(load('reportlab.pdf'));
    const p1 = scan.findings.filter((f) => f.page === 1).map((f) => `${f.location}:${f.matchText}`);
    expect(p1).toEqual(
      expect.arrayContaining(['header:Company Confidential', 'footer:Internal Use Only', 'watermark:CONFIDENTIAL', 'body:strictly confidential', 'body:Secret', 'body:公司機密']),
    );
    expect(rescan.findings).toEqual([]);
    expect(rawScan('pdf', out, compiled)).toEqual([]);
    const t = pypdfText(out, 'reportlab_clean.pdf');
    if (t !== undefined) expect(t).toMatch(/project codename/);
  });
});

describe('PDF logos', () => {
  it('detects the same image repeated on every page, removes all placements and the image data itself', async () => {
    const input = load('reportlab.pdf');
    const { findings } = await pdfHandler.scan(input, ctx);
    const logos = findings.filter((f) => f.kind === 'image');
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ location: 'header', confidence: 'high', defaultSelected: true, page: 1 });
    expect(logos[0]!.note).toMatch(/2 頁/);
    expect(logos[0]!.thumbnail).toMatch(/^data:image\/png;base64,/); // decoded in-engine (Flate + ASCII85)
    expect(logos[0]!.rects![0]!.y).toBeLessThan(0.1);
    const out = await pdfHandler.apply(input, ctx, new Set([logos[0]!.id]));
    expect(latin1(out)).not.toMatch(/\/Subtype\s*\/Image/);
    expect((await pdfHandler.scan(out, ctx)).findings.some((f) => f.kind === 'image')).toBe(false);
    // text is untouched when only the logo was selected
    expect((await pdfHandler.scan(out, ctx)).findings.filter((f) => f.kind === 'text').length).toBe(findings.filter((f) => f.kind === 'text').length);
  });

  it('matches a user-supplied logo sample', async () => {
    const { logoHash, pngDecode } = await import('../src/core/image');
    const sample = logoHash(pngDecode(load('logo.png'))!);
    const { findings } = await pdfHandler.scan(load('reportlab.pdf'), { ...ctx, logoHashes: [sample] });
    expect(findings.find((f) => f.kind === 'image')!.matchText).toBe('Logo（符合樣本）');
  });
});

describe('PDF form fields (AcroForm)', () => {
  it('cleans field values, tooltips and choice options; unrelated fields keep value and appearance', async () => {
    const input = load('form.pdf');
    const { findings } = await pdfHandler.scan(input, ctx);
    const form = findings.filter((f) => f.location === 'formField');
    expect(form.map((f) => f.where)).toEqual(expect.arrayContaining(['表單欄位「classification」', '表單欄位「classification」・提示文字', '表單欄位「level」', '表單欄位「level」・選項']));
    expect(form.some((f) => f.where.includes('owner'))).toBe(false);
    const out = await pdfHandler.apply(input, ctx, new Set(findings.map((f) => f.id)));
    expect((await pdfHandler.scan(out, ctx)).findings.filter((f) => f.location === 'formField')).toEqual([]);
    expect(rawScan('pdf', out, compiled)).toEqual([]);
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.load(out);
    const af = doc.catalog.lookup(PDFName.of('AcroForm')) as import('pdf-lib').PDFDict;
    expect(String(af.get(PDFName.of('NeedAppearances')))).toBe('true');
    const byName = Object.fromEntries(doc.getForm().getFields().map((f) => [f.getName(), f]));
    expect(byName['owner']!.acroField.dict.get(PDFName.of('AP'))).toBeDefined(); // untouched field keeps its appearance
    expect(byName['classification']!.acroField.dict.get(PDFName.of('AP'))).toBeUndefined();
    expect(latin1(out)).toMatch(/Finance team/);
    const t = pypdfText(out, 'form_clean.pdf');
    if (t !== undefined) expect(t).toMatch(/Classification:/);
  });
});

describe('tagged PDF structure tree', () => {
  it('cleans accessibility text (/Alt of a logo) and keeps the tree', async () => {
    const input = load('tagged.pdf');
    const { findings } = await pdfHandler.scan(input, ctx);
    const alt = findings.find((f) => f.where.startsWith('無障礙標籤・替代文字'))!;
    expect(alt.matchText).toBe('Confidential');
    const out = await pdfHandler.apply(input, ctx, new Set([alt.id]));
    expect(latin1(out)).not.toMatch(/ACME Confidential logo/);
    expect(latin1(out)).toMatch(/StructTreeRoot/);
    const t = pypdfText(out, 'tagged_clean.pdf');
    if (t !== undefined) expect(t).toMatch(/Quarterly report/);
  });
});

describe('scanned PDF with OCR layer', () => {
  it('removes the searchable OCR text but warns that the image still shows the label', async () => {
    const { findings, warnings } = await pdfHandler.scan(load('scanned.pdf'), ctx);
    expect(warnings.join()).toMatch(/第 1 頁是掃描影像/);
    const ocr = findings.find((f) => f.matchText === 'CONFIDENTIAL')!;
    expect(ocr.note).toMatch(/OCR 隱形文字層/);
  });

  it('ordinary PDFs with pictures are not called scans', async () => {
    for (const name of ['office.pdf', 'reportlab.pdf', 'tagged.pdf']) {
      expect((await pdfHandler.scan(load(name), ctx)).warnings.join(), name).not.toMatch(/掃描影像/);
    }
  });
});

describe('PDF incremental updates', () => {
  it('drops stale revisions that still contain the label, even when nothing is selected', async () => {
    const input = load('incremental.pdf');
    expect(rawScan('pdf', input, compiled).map((h) => h.text)).toContain('CONFIDENTIAL'); // the orphan is really there
    const out = await pdfHandler.apply(input, ctx, new Set());
    expect(rawScan('pdf', out, compiled)).toEqual([]);
    const text = pypdfText(out, 'incremental_clean.pdf');
    if (text !== undefined) expect(text).toMatch(/Public version/);
  });
});

describe('rawScan', () => {
  it('sees text inside compressed streams and hex strings', () => {
    expect(rawScan('pdf', load('reportlab.pdf'), compiled).length).toBeGreaterThan(0);
  });
});
