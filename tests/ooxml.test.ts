import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules';
import type { FormatHandler, ScanContext } from '../src/core/types';
import { docxHandler, pptxHandler, xlsxHandler } from '../src/formats/ooxml/handler';
import { tokenizeFormula, tokenizeHeaderFooter } from '../src/formats/ooxml/xlsx';

const ctx: ScanContext = { rules: [...DEFAULT_RULES] };
const load = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));
const parts = (bytes: Uint8Array) => unzipSync(bytes);
const part = (bytes: Uint8Array, path: string) => {
  const p = parts(bytes)[path];
  return p ? strFromU8(p) : undefined;
};

/** Apply every removable finding. */
async function cleanAll(h: FormatHandler, bytes: Uint8Array) {
  const scan = await h.scan(bytes, ctx);
  const ids = new Set(scan.findings.filter((f) => f.removable).map((f) => f.id));
  const out = await h.apply(bytes, ctx, ids);
  return { scan, out, rescan: await h.scan(out, ctx) };
}

let python = false;
beforeAll(() => {
  try {
    execFileSync('python3', ['-c', 'import docx, openpyxl, pptx'], { stdio: 'ignore' });
    python = true;
  } catch {
    python = false;
  }
  mkdirSync('tests/output', { recursive: true });
});

/** Open the file with the reference Python library — proves the package is still a valid document. */
function assertOpens(bytes: Uint8Array, ext: 'docx' | 'xlsx' | 'pptx') {
  if (!python) return;
  const file = `tests/output/opens.${ext}`;
  writeFileSync(file, bytes);
  const code = {
    docx: 'import docx,sys; d=docx.Document(sys.argv[1]); [s.header.paragraphs for s in d.sections]',
    xlsx: 'import openpyxl,sys; openpyxl.load_workbook(sys.argv[1])',
    pptx: 'import pptx,sys; [s.shapes for s in pptx.Presentation(sys.argv[1]).slides]',
  }[ext];
  execFileSync('python3', ['-c', code, file], { stdio: 'pipe' });
}

describe.each([
  ['sample.docx', docxHandler, 'docx'],
  ['sample.xlsx', xlsxHandler, 'xlsx'],
  ['sample.pptx', pptxHandler, 'pptx'],
] as const)('%s', (name, handler, ext) => {
  it('finding ids are unique and stable across scans', async () => {
    const a = await handler.scan(load(name), ctx);
    const b = await handler.scan(load(name), ctx);
    const ids = a.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.findings.map((f) => f.id)).toEqual(ids);
  });

  it('leaves nothing removable behind after cleaning everything', async () => {
    const { rescan, out } = await cleanAll(handler, load(name));
    expect(rescan.findings.filter((f) => f.removable)).toEqual([]);
    assertOpens(out, ext);
    writeFileSync(`tests/output/clean.${ext}`, out);
  });

  it('keeps every untouched part byte-identical when nothing is selected', async () => {
    const input = load(name);
    const out = await handler.apply(input, ctx, new Set());
    const a = parts(input);
    const b = parts(out);
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const k of Object.keys(a)) expect(b[k], k).toEqual(a[k]);
  });

  it('removes Purview labels, LabelInfo.xml and the thumbnail together with their references', async () => {
    const { out } = await cleanAll(handler, load(name));
    const p = parts(out);
    expect(Object.keys(p).some((k) => /LabelInfo|thumbnail/i.test(k))).toBe(false);
    const ct = strFromU8(p['[Content_Types].xml']!);
    const rels = strFromU8(p['_rels/.rels']!);
    expect(ct).not.toMatch(/LabelInfo/);
    expect(rels).not.toMatch(/classificationlabels|thumbnail/);
    const custom = strFromU8(p['docProps/custom.xml']!);
    expect(custom).not.toMatch(/MSIP_Label|Classification|Restricted/);
    expect(custom).toMatch(/name="Project"/); // unrelated custom properties survive
    expect(custom).toMatch(/Apollo/);
    expect(strFromU8(p['docProps/app.xml']!)).not.toMatch(/ACME Corp/);
    expect(strFromU8(p['docProps/core.xml']!)).not.toMatch(/Jane Doe/);
  });
});

describe('docx specifics', () => {
  it('finds labels in every hiding place', async () => {
    const { findings } = await docxHandler.scan(load('sample.docx'), ctx);
    const by = (loc: string) => findings.filter((f) => f.location === loc).map((f) => f.matchText);
    expect(by('header')).toEqual(['Confidential']); // split across runs "Confi" + "dential"
    expect(by('watermark')).toEqual(['CONFIDENTIAL']);
    expect(by('footer')).toEqual(['Restricted', 'Internal Use Only']);
    expect(by('textbox')).toEqual(['Internal Only']);
    expect(by('comment')).toEqual(['Do not distribute']);
    expect(findings.find((f) => f.matchText === 'Sensitive')?.note).toMatch(/追蹤修訂/);
    expect(findings.find((f) => f.matchText === 'STRICTLY CONFIDENTIAL')?.confidence).toBe('high');
    expect(findings.find((f) => f.matchText === 'confidential')?.note).toMatch(/改變語意/);
    expect(findings.some((f) => /Secretary/.test(f.matchText))).toBe(false);
  });

  it('cuts text, unlinks fields that would re-populate, keeps unrelated fields and text', async () => {
    const { out } = await cleanAll(docxHandler, load('sample.docx'));
    const header = part(out, 'word/header1.xml')!;
    expect(header).not.toMatch(/Confi|PowerPlusWaterMarkObject/);
    expect(header).toMatch(/ACME/);
    const footer = part(out, 'word/footer1.xml')!;
    expect(footer).not.toMatch(/DOCPROPERTY|Restricted|Internal Use Only/);
    expect(footer).toMatch(/ PAGE /); // the PAGE field is untouched
    const body = part(out, 'word/document.xml')!;
    expect(body).toMatch(/The Secretary approved the budget\./);
    expect(body).not.toMatch(/DOCPROPERTY Status|Top Secret|Sensitive|公司機密/);
    expect(body).toMatch(/本文件為。/);
    expect(body).toMatch(/<w:t xml:space="preserve">This document contains information about the plan\.<\/w:t>/);
  });

  it('honours exceptions', async () => {
    const input = load('sample.docx');
    const { findings } = await docxHandler.scan(input, ctx);
    const keep = findings.find((f) => f.location === 'header')!;
    const ids = new Set(findings.filter((f) => f.removable && f.id !== keep.id).map((f) => f.id));
    const out = await docxHandler.apply(input, ctx, ids);
    expect(part(out, 'word/header1.xml')).toMatch(/Confi/);
    const rescan = await docxHandler.scan(out, ctx);
    expect(rescan.findings.map((f) => f.id)).toEqual([keep.id]);
  });
});

describe('xlsx specifics', () => {
  it('handles header/footer codes, formula literals and sheet names', async () => {
    const { findings } = await xlsxHandler.scan(load('sample.xlsx'), ctx);
    const sheetName = findings.find((f) => f.location === 'sheetName')!;
    expect(sheetName).toMatchObject({ matchText: 'Secret Data', removable: false, defaultSelected: false });
    const { out } = await cleanAll(xlsxHandler, load('sample.xlsx'));
    const sheet1 = part(out, 'xl/worksheets/sheet1.xml')!;
    expect(sheet1).toMatch(/&amp;"Arial,Bold"/); // formatting codes kept
    expect(sheet1).toMatch(/R&amp;&amp;D/); // literal ampersand re-escaped
    expect(sheet1).toMatch(/Page &amp;P/);
    expect(sheet1).toMatch(/<f>IF\(A2&gt;0,"","OK"\)<\/f>/);
    expect(sheet1).toMatch(/Secretary/);
    expect(part(out, 'xl/workbook.xml')).toMatch(/name="Secret Data"/); // report-only, never renamed
  });

  it('tokenizes formulas without touching quoted sheet references', () => {
    const t = tokenizeFormula(`'Confidential Data'!A1&"Secret ""x"""`);
    expect(t.filter((x) => x.literal).map((x) => x.text)).toEqual(['Secret "x"']);
    expect(t.map((x) => x.raw).join('')).toBe(`'Confidential Data'!A1&"Secret ""x"""`);
  });

  it('tokenizes header/footer codes', () => {
    const t = tokenizeHeaderFooter('&L&"Arial,Bold"&12Confidential&C&P of &N&R&KFF0000R&&D&K01+000x');
    expect(t.filter((x) => !x.code).map((x) => x.text)).toEqual(['Confidential', ' of ', 'R&D', 'x']);
    expect(t.filter((x) => x.code).map((x) => x.raw)).toEqual(['&L', '&"Arial,Bold"', '&12', '&C', '&P', '&N', '&R', '&KFF0000', '&K01+000']);
  });
});

describe('pptx specifics', () => {
  it('cleans masters, notes, charts and the embedded chart workbook', async () => {
    const { scan, out } = await cleanAll(pptxHandler, load('sample.pptx'));
    expect(scan.findings.some((f) => f.location === 'footer' && /母片/.test(f.where))).toBe(true);
    expect(scan.findings.some((f) => f.id.startsWith('ppt/embeddings/'))).toBe(true);
    expect(part(out, 'ppt/slideMasters/slideMaster1.xml')).not.toMatch(/Confidential/);
    expect(part(out, 'ppt/charts/chart1.xml')).not.toMatch(/Confidential|Secret/);
    const embedded = parts(out)['ppt/embeddings/Microsoft_Excel_Sheet1.xlsx']!;
    expect(strFromU8(unzipSync(embedded)['xl/sharedStrings.xml']!)).not.toMatch(/Confidential/);
    expect(part(out, 'ppt/slides/slide2.xml')).toMatch(/Growth is 12%/);
  });
});
