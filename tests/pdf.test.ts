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
