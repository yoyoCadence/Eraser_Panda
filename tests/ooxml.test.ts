import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
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
  // same documents re-saved by LibreOffice: a second producer (shared strings, other run splitting, …)
  ['sample_lo.docx', docxHandler, 'docx'],
  ['sample_lo.xlsx', xlsxHandler, 'xlsx'],
  ['sample_lo.pptx', pptxHandler, 'pptx'],
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
    const by = (loc: string) => findings.filter((f) => f.location === loc && f.kind !== 'image').map((f) => f.matchText);
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

describe('comment / revision authors', () => {
  it.each([
    ['sample.docx', docxHandler, ['Jane Doe', 'Reviewer']],
    ['sample.xlsx', xlsxHandler, ['Reviewer']],
  ] as const)('%s: names are found and replaced with "Author"', async (name, handler, expected) => {
    const input = load(name);
    const { findings } = await handler.scan(input, ctx);
    const f = findings.find((x) => x.id === 'authors#people')!;
    for (const n of expected) expect(f.matchText).toContain(n);
    const out = await handler.apply(input, ctx, new Set([f.id]));
    const xml = Object.entries(parts(out))
      .filter(([k]) => k.endsWith('.xml') && !k.startsWith('docProps/'))
      .map(([, v]) => strFromU8(v))
      .join('');
    for (const n of expected) expect(xml).not.toContain(n);
    expect(xml).toContain('Author');
    assertOpens(out, name.slice(-4) as 'docx' | 'xlsx');
  });
});

describe('account ids next to author names', () => {
  it('docx people.xml: presenceInfo (Office account e-mail) is removed, the part stays valid', async () => {
    const p = parts(load('sample.docx'));
    p['word/people.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
        '<w15:person w15:author="Jane Doe"><w15:presenceInfo w15:providerId="AD" w15:userId="S::jane.doe@acme.example::1234"/></w15:person></w15:people>',
    );
    p['[Content_Types].xml'] = strToU8(
      strFromU8(p['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/></Types>'),
    );
    const input = zipSync(p);
    const { findings } = await docxHandler.scan(input, ctx);
    const f = findings.find((x) => x.id === 'authors#people')!;
    const out = await docxHandler.apply(input, ctx, new Set([f.id]));
    const people = strFromU8(parts(out)['word/people.xml']!);
    expect(people).not.toMatch(/jane|Jane|acme|presenceInfo/);
    expect(people).toMatch(/w15:author="Author"/);
  });

  it('pptx authors.xml: userId / providerId get valid placeholder values, never empty', async () => {
    const p = parts(load('sample.pptx'));
    p['ppt/authors.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main">' +
        '<p188:author id="{1}" name="Jane Doe" initials="JD" userId="jane.doe@acme.example" providerId="AD"/></p188:authorLst>',
    );
    p['[Content_Types].xml'] = strToU8(
      strFromU8(p['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/ppt/authors.xml" ContentType="application/vnd.ms-powerpoint.authors+xml"/></Types>'),
    );
    const input = zipSync(p);
    const { findings } = await pptxHandler.scan(input, ctx);
    const f = findings.find((x) => x.id === 'authors#people')!;
    expect(f.matchText).toContain('Jane Doe');
    const out = await pptxHandler.apply(input, ctx, new Set([f.id]));
    const authors = strFromU8(parts(out)['ppt/authors.xml']!);
    expect(authors).not.toMatch(/jane|Jane|acme|""/);
    expect(authors).toMatch(/name="Author"/);
    expect(authors).toMatch(/providerId="None"/);
  });
});

describe('alt text and Excel validation / conditional formats', () => {
  it('docx / pptx picture alt text (descr / title) is cleaned', async () => {
    for (const [name, handler, partRe] of [
      ['sample.docx', docxHandler, /^word\/header1\.xml$/],
      ['sample.pptx', pptxHandler, /^ppt\/slides\/slide1\.xml$/],
    ] as const) {
      const p = parts(load(name));
      const part = Object.keys(p).find((k) => partRe.test(k))!;
      p[part] = strToU8(strFromU8(p[part]!).replace(/(<(?:wp|p):(?:docPr|cNvPr) [^>]*?)name="([^"]*)"/, '$1name="$2" descr="ACME Confidential stamp" title="Internal Use Only"'));
      const input = zipSync(p);
      const { findings } = await handler.scan(input, ctx);
      const alt = findings.filter((f) => f.where.includes('替代文字'));
      expect(alt.map((f) => f.matchText).sort(), name).toEqual(['Confidential', 'Internal Use Only']);
      const out = await handler.apply(input, ctx, new Set(alt.map((f) => f.id)));
      const xml = strFromU8(parts(out)[part]!);
      expect(xml, name).toMatch(/descr="ACME stamp"/);
      expect(xml, name).not.toMatch(/Internal Use Only/);
      assertOpens(out, name.slice(-4) as 'docx' | 'pptx');
    }
  });

  it('xlsx data-validation lists / prompts are cut; conditional-format rules on a label are removed whole', async () => {
    const p = parts(load('sample.xlsx'));
    const sheet = strFromU8(p['xl/worksheets/sheet1.xml']!).replace(
      '<pageMargins',
      '<conditionalFormatting sqref="A1:D9"><cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="Confidential"><formula>NOT(ISERROR(SEARCH("Confidential",A1)))</formula></cfRule></conditionalFormatting>' +
        '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" promptTitle="Classification" prompt="Pick Confidential or Public" sqref="E1:E9"><formula1>"Confidential,Internal,Public"</formula1></dataValidation></dataValidations>' +
        '<pageMargins',
    );
    p['xl/worksheets/sheet1.xml'] = strToU8(sheet);
    const input = zipSync(p);
    const { findings } = await xlsxHandler.scan(input, ctx);
    const dv = findings.filter((f) => f.where.includes('資料驗證'));
    const cf = findings.filter((f) => f.where.includes('條件式格式'));
    expect(dv.length).toBeGreaterThanOrEqual(2);
    expect(cf).toHaveLength(1);
    const out = await xlsxHandler.apply(input, ctx, new Set([...dv, ...cf].map((f) => f.id)));
    const x = strFromU8(parts(out)['xl/worksheets/sheet1.xml']!);
    expect(x).toMatch(/<formula1>"Internal,Public"<\/formula1>/);
    expect(x).toMatch(/prompt="Pick or Public"|prompt="Pick Public"|prompt="Pick  or Public"/);
    expect(x).not.toMatch(/cfRule|conditionalFormatting/); // the rule (and its now-empty container) is gone
    expect(/<dataValidations[\s\S]*<\/dataValidations>/.exec(x)![0]).not.toMatch(/Confidential/);
    assertOpens(out, 'xlsx');
  });
});

describe('logos', () => {
  const media = (bytes: Uint8Array) => Object.keys(parts(bytes)).filter((k) => /\/media\//.test(k)).sort();

  it.each([
    ['sample.docx', docxHandler, 'header'],
    ['sample.pptx', pptxHandler, 'body'],
    ['sample.xlsx', xlsxHandler, 'body'],
  ] as const)('%s: finds the logo, ignores ordinary pictures, removes the logo media', async (name, handler, location) => {
    const input = load(name);
    const { findings } = await handler.scan(input, ctx);
    const logos = findings.filter((f) => f.kind === 'image' && f.matchText.includes('Logo'));
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ location, confidence: 'high', defaultSelected: true });
    expect(logos[0]!.thumbnail).toMatch(/^data:image\/png;base64,/);
    const before = media(input);
    const out = await handler.apply(input, ctx, new Set([logos[0]!.id]));
    const after = media(out);
    expect(after.length).toBeLessThan(before.length); // the logo file(s) are gone …
    expect(after.length).toBe(before.length - (name.endsWith('xlsx') ? 2 : 1)); // … (xlsx stores one copy per sheet), ordinary pictures stay
    expect((await handler.scan(out, ctx)).findings.some((f) => f.kind === 'image' && f.matchText.includes('Logo'))).toBe(false);
    assertOpens(out, name.slice(-4) as 'docx' | 'xlsx' | 'pptx');
  });

  it('xlsx header/footer picture (&G + legacyDrawingHF) is removed with its VML part and media', async () => {
    const p = parts(load('sample.xlsx'));
    const sheet = strFromU8(p['xl/worksheets/sheet1.xml']!)
      .replace('<oddHeader>', '<oddHeader>&amp;L&amp;G')
      .replace('</worksheet>', '<legacyDrawingHF xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdHF"/></worksheet>');
    p['xl/worksheets/sheet1.xml'] = strToU8(sheet);
    p['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      strFromU8(p['xl/worksheets/_rels/sheet1.xml.rels']!).replace(
        '</Relationships>',
        '<Relationship Id="rIdHF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawingHF1.vml"/></Relationships>',
      ),
    );
    p['xl/drawings/vmlDrawingHF1.vml'] = strToU8(
      '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:shape id="LH" type="#_x0000_t75" style="position:absolute;width:60pt;height:30pt"><v:imagedata o:relid="rId1" o:title="logo"/></v:shape></xml>',
    );
    p['xl/drawings/_rels/vmlDrawingHF1.vml.rels'] = strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/hflogo.png"/></Relationships>',
    );
    p['xl/media/hflogo.png'] = new Uint8Array(readFileSync('tests/fixtures/logo.png'));
    const input = zipSync(p);
    const { findings } = await xlsxHandler.scan(input, ctx);
    const hf = findings.find((f) => f.id === 'xl/worksheets/sheet1.xml#hfimage')!;
    expect(hf).toMatchObject({ kind: 'image', confidence: 'high' });
    const out = await xlsxHandler.apply(input, ctx, new Set([hf.id]));
    const q = parts(out);
    const s1 = strFromU8(q['xl/worksheets/sheet1.xml']!);
    expect(s1).not.toMatch(/legacyDrawingHF|&amp;G/);
    expect(s1).toMatch(/<oddHeader>&amp;L&amp;C&amp;"Arial,Bold"Strictly Confidential<\/oddHeader>/); // the rest of the header is intact
    expect(Object.keys(q).some((k) => /vmlDrawingHF1|hflogo/.test(k))).toBe(false);
    expect(strFromU8(q['xl/worksheets/_rels/sheet1.xml.rels']!)).not.toMatch(/rIdHF/);
    assertOpens(out, 'xlsx');
  });

  it('matches a logo sample even where heuristics would not flag it', async () => {
    const { logoHash, pngDecode } = await import('../src/core/image');
    const photo = logoHash(pngDecode(new Uint8Array(readFileSync('tests/fixtures/photo.png')))!);
    const { findings } = await docxHandler.scan(load('sample.docx'), { ...ctx, logoHashes: [photo] });
    expect(findings.filter((f) => f.matchText === 'Logo（符合樣本）')).toHaveLength(1);
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
