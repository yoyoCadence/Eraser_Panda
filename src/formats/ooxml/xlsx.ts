import { findHits, type CompiledRules } from '../../core/matcher';
import type { Segment } from '../../core/segments';
import { chartsOf, collectAltText, collectChart, collectDmlParagraphs } from './drawingml';
import { markDirtyOnWrite } from './metadata';
import type { Fragment, OoxmlPackage } from './package';
import { attrUnit, elementUnit, type Candidate, type SegRef, type TextUnit } from './units';
import { NS, childEls, els, firstChildEl } from './xml';

const REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** `<c …>…</c>` or `<c …/>` — attributes in group 1, body in group 2. */
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/** XML entity decoding only — tags and attribute values are kept (cheap pre-checks on raw XML). */
const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Text content of an XML snippet: tags dropped, entities decoded. */
const decodeXml = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' '));

export const HF_RE = /<headerFooter\b[^>]*?(?:\/>|>[\s\S]*?<\/headerFooter>)/;
const SI_RE = /<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g;
const DV_RE = /<dataValidation\b[^>]*?(?:\/>|>[\s\S]*?<\/dataValidation>)/g;
const CF_RE = /<conditionalFormatting\b[^>]*?>[\s\S]*?<\/conditionalFormatting>/g;


/** Text a cell carries itself (inline string, formula literals, cached string result) — cheap pre-check. */
function cellLocalText(attrs: string, body: string): string {
  const parts: string[] = [];
  const is = /<is>([\s\S]*?)<\/is>/.exec(body);
  if (is) parts.push(decodeXml(is[1]!));
  const f = /<f\b[^>]*>([^<]*)<\/f>/.exec(body);
  if (f && (f[1]!.includes('&quot;') || f[1]!.includes('"'))) parts.push(decodeXml(f[1]!));
  if (/\bt="str"/.test(attrs)) {
    const v = /<v>([^<]*)<\/v>/.exec(body);
    if (v) parts.push(decodeXml(v[1]!));
  }
  return parts.join('\n');
}

/** Header/footer text without formatting codes — cheap pre-check. */
function hfPlainText(xml: string): string {
  return decodeXml(xml)
    .replace(/&&/g, '\u0000')
    .replace(/&"[^"]*"|&K[0-9A-Fa-f+\-S]{0,6}|&\d+|&[A-Z]/g, ' ')
    .replace(/\u0000/g, '&');
}

/** Like markDirtyOnWrite, for units living in a fragment of a huge part. */
function touchOnWrite(frag: Fragment, unit: TextUnit): TextUnit {
  const prev = unit.afterWrite;
  return {
    ...unit,
    afterWrite: (changed) => {
      if (changed.length) frag.touch();
      prev?.(changed);
    },
  };
}

interface SheetInfo {
  name: string;
  index: number; // 1-based
  path: string;
}

export function workbookPath(pkg: OoxmlPackage): string | undefined {
  return pkg.rels('').find((r) => r.type === REL_DOC)?.target ?? (pkg.has('xl/workbook.xml') ? 'xl/workbook.xml' : undefined);
}

function sheets(pkg: OoxmlPackage, wb: string): SheetInfo[] {
  const doc = pkg.xml(wb);
  if (!doc) return [];
  const out: SheetInfo[] = [];
  els(doc, NS.s, 'sheet').forEach((el, i) => {
    const rId = el.getAttributeNS(NS.r, 'id') ?? '';
    const path = pkg.relTarget(wb, rId);
    if (path && pkg.has(path)) out.push({ name: el.getAttribute('name') ?? `Sheet${i + 1}`, index: i + 1, path });
  });
  return out;
}

export function collectXlsx(pkg: OoxmlPackage, compiled: CompiledRules): { units: TextUnit[]; candidates: Candidate[] } {
  const units: TextUnit[] = [];
  const candidates: Candidate[] = [];
  const wb = workbookPath(pkg);
  if (!wb) return { units, candidates };
  const sheetList = sheets(pkg, wb);
  const ssRefs = new Map<number, string[]>(); // shared string index → cell refs
  const ssFirstSheet = new Map<number, number>();

  for (const sh of sheetList) {
    const xml = pkg.text(sh.path) ?? '';
    const label = (ref: string) => `${sh.name}!${ref}`;

    // Shared-string references are collected with a regex: worksheets can hold millions of cells and a DOM of
    // them does not fit in memory. The DOM is only built when the sheet itself contains a hit (below).
    for (const m of xml.matchAll(CELL_RE)) {
      const attrs = m[1]!;
      if (!/\bt="s"/.test(attrs)) continue;
      const idx = Number(/<v>(\d+)<\/v>/.exec(m[2] ?? '')?.[1]);
      if (!Number.isInteger(idx)) continue;
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '?';
      const list = ssRefs.get(idx);
      if (list) list.push(label(ref));
      else {
        ssRefs.set(idx, [label(ref)]);
        ssFirstSheet.set(idx, sh.index);
      }
    }

    // Cells with text of their own (inline strings, formulas, cached string results) are parsed one by one as tiny
    // fragments — only when they contain a hit. The worksheet itself is never parsed as a whole.
    for (const m of xml.matchAll(CELL_RE)) {
      const attrs = m[1]!;
      const body = m[2] ?? '';
      if (!body || !findHits(cellLocalText(attrs, body), compiled).length) continue;
      const frag = pkg.fragment(sh.path, m.index!, m.index! + m[0].length);
      const c = frag.el;
      const ref = c.getAttribute('r') ?? '?';
      const t = c.getAttribute('t');
      if (t === 'inlineStr') {
        const is = firstChildEl(c, NS.s, 'is');
        if (is) units.push(touchOnWrite(frag, richTextUnit(is, { part: sh.path, key: `is:${ref}`, location: 'body', where: label(ref), page: sh.index })));
      }
      const f = firstChildEl(c, NS.s, 'f');
      if (f?.textContent?.includes('"')) {
        const u = formulaUnit(frag.touch, sh.path, f, { key: `f:${ref}`, where: `${label(ref)} 公式`, page: sh.index });
        if (u) units.push(u);
      }
      if (t === 'str') {
        // cached result of a string formula — would keep showing the label until Excel recalculates
        const v = firstChildEl(c, NS.s, 'v');
        if (v?.textContent) units.push(touchOnWrite(frag, elementUnit(v, { part: sh.path, key: `v:${ref}`, location: 'formula', where: `${label(ref)} 公式結果`, page: sh.index })));
      }
    }

    // ---- header / footer ----
    const hfMatch = HF_RE.exec(xml);
    if (hfMatch && findHits(hfPlainText(hfMatch[0]), compiled).length) {
      const frag = pkg.fragment(sh.path, hfMatch.index, hfMatch.index + hfMatch[0].length);
      for (const el of childEls(frag.el, NS.s)) {
        if (!el.textContent) continue;
        const isHeader = /Header$/.test(el.localName);
        const variant = el.localName.startsWith('first') ? '首頁' : el.localName.startsWith('even') ? '偶數頁' : '';
        units.push(headerFooterUnit(frag.touch, sh.path, el, { key: `hf:${el.localName}`, location: isHeader ? 'header' : 'footer', where: `${sh.name}・${variant}${isHeader ? '頁首' : '頁尾'}`, page: sh.index }));
      }
    }

    // ---- data validation: dropdown lists ("Confidential,Internal,Public") and input / error messages ----
    for (const m of xml.matchAll(DV_RE)) {
      if (!findHits(decodeEntities(m[0]), compiled).length) continue;
      const frag = pkg.fragment(sh.path, m.index!, m.index! + m[0].length);
      const where = `${sh.name}・資料驗證（${frag.el.getAttribute('sqref') ?? ''}）`;
      for (const a of ['promptTitle', 'prompt', 'errorTitle', 'error']) {
        if (frag.el.getAttribute(a)) units.push(touchOnWrite(frag, attrUnit(frag.el, a, { part: sh.path, key: `dv${m.index}:${a}`, location: 'other', where, page: sh.index })));
      }
      for (const f of childEls(frag.el, NS.s).filter((c) => c.localName === 'formula1' || c.localName === 'formula2')) {
        const u = formulaUnit(frag.touch, sh.path, f, { key: `dv${m.index}:${f.localName}`, where, page: sh.index });
        if (u) units.push(u);
      }
    }

    // ---- conditional formatting: a rule keyed on a label is removed whole ----
    // Cutting only the text would turn SEARCH("Confidential",A1) into SEARCH("",A1), which matches every cell.
    for (const m of xml.matchAll(CF_RE)) {
      if (!findHits(decodeEntities(m[0]), compiled).length) continue;
      const frag = pkg.fragment(sh.path, m.index!, m.index! + m[0].length);
      childEls(frag.el, NS.s, 'cfRule').forEach((rule, i) => {
        const formulas = childEls(rule, NS.s, 'formula').map((f) => f.textContent ?? '');
        units.push({
          part: sh.path,
          key: `cf${m.index}:${i}`,
          location: 'other',
          kind: 'text',
          where: `${sh.name}・條件式格式（${frag.el.getAttribute('sqref') ?? ''}）`,
          page: sh.index,
          segments: [{ text: rule.getAttribute('text') ?? '' }, ...formulas.flatMap((t) => [{ text: '\n', virtual: true }, { text: t }])],
          refs: [null, ...formulas.flatMap(() => [null, null])],
          wholeObject: {
            label: '整條條件式格式規則將被移除（只刪字眼會讓規則套用到所有儲存格）',
            remove: () => {
              rule.parentNode?.removeChild(rule);
              if (!childEls(frag.el, NS.s, 'cfRule').length) frag.remove();
              else frag.touch();
            },
          },
        });
      });
    }

    // ---- related parts: comments, threaded comments, drawings (+charts) ----
    for (const rel of pkg.rels(sh.path)) {
      if (rel.external || !pkg.has(rel.target)) continue;
      if (/\/comments$/.test(rel.type)) units.push(...collectLegacyComments(pkg, rel.target, sh));
      else if (/\/threadedComment$/.test(rel.type)) units.push(...collectThreaded(pkg, rel.target, sh));
      else if (/\/drawing$/.test(rel.type)) {
        units.push(...collectDmlParagraphs(pkg, rel.target, { location: 'textbox', where: `${sh.name}・圖形文字`, page: sh.index }));
        units.push(...collectAltText(pkg, rel.target, sh.name, sh.index));
        for (const ch of chartsOf(pkg, rel.target)) units.push(...collectChart(pkg, ch, `${sh.name}・圖表`, sh.index));
      }
    }

    // ---- sheet name: report only ----
    if (findHits(sh.name, compiled).length) {
      candidates.push({
        finding: {
          id: `${wb}#sheet:${sh.index}`,
          kind: 'text',
          location: 'sheetName',
          matchText: sh.name,
          context: { before: '工作表名稱「', match: sh.name, after: '」' },
          where: `工作表 ${sh.index}`,
          page: sh.index,
          part: wb,
          confidence: 'high',
          removable: false,
          defaultSelected: false,
          note: '工作表名稱會被公式、圖表、樞紐分析參照，自動改名可能破壞活頁簿。請在 Excel 中手動重新命名。',
        },
      });
    }
  }

  // ---- shared strings ----
  // The shared-string table can hold hundreds of thousands of entries: only entries with a hit are parsed.
  for (const ssPath of pkg.partsByType('spreadsheetml.sharedStrings+xml')) {
    const xml = pkg.text(ssPath) ?? '';
    let i = -1;
    for (const m of xml.matchAll(SI_RE)) {
      i++;
      if (!findHits(decodeXml(m[0]), compiled).length) continue;
      const frag = pkg.fragment(ssPath, m.index!, m.index! + m[0].length);
      const refs = ssRefs.get(i);
      const where = refs ? (refs.length > 1 ? `${refs[0]} 等 ${refs.length} 個儲存格` : refs[0]!) : '共用字串（未被儲存格使用）';
      units.push(touchOnWrite(frag, richTextUnit(frag.el, { part: ssPath, key: `si${i}`, location: 'body', where, page: ssFirstSheet.get(i) })));
    }
  }

  // ---- pivot caches: copies of source data strings ----
  for (const pc of pkg.partsByType('spreadsheetml.pivotCacheDefinition+xml')) {
    const doc = pkg.xml(pc);
    if (!doc) continue;
    els(doc, NS.s, 's').forEach((s, i) => {
      if (s.getAttribute('v')) units.push(markDirtyAttr(pkg, pc, attrUnit(s, 'v', { part: pc, key: `s${i}`, location: 'other', where: '樞紐分析快取' })));
    });
    els(doc, NS.s, 'cacheField').forEach((cf, i) => {
      if (cf.getAttribute('name')) units.push(markDirtyAttr(pkg, pc, attrUnit(cf, 'name', { part: pc, key: `cf${i}`, location: 'other', where: '樞紐分析欄位名稱' })));
    });
  }

  return { units, candidates };
}

function markDirtyAttr(pkg: OoxmlPackage, path: string, u: TextUnit): TextUnit {
  return markDirtyOnWrite(pkg, path, u);
}

/** <si>/<is>/<text>: either a plain <t> or rich runs <r><t>. Phonetic runs (<rPh>) are ignored. */
function richTextUnit(container: Element, base: Omit<TextUnit, 'segments' | 'refs'>): TextUnit {
  const segments: Segment[] = [];
  const refs: SegRef[] = [];
  for (const c of childEls(container, NS.s)) {
    if (c.localName === 't') {
      segments.push({ text: c.textContent ?? '' });
      refs.push({ el: c });
    } else if (c.localName === 'r') {
      const t = firstChildEl(c, NS.s, 't');
      if (t) {
        segments.push({ text: t.textContent ?? '' });
        refs.push({ el: t });
      }
    }
  }
  return { ...base, segments, refs };
}

function collectLegacyComments(pkg: OoxmlPackage, path: string, sh: SheetInfo): TextUnit[] {
  const doc = pkg.xml(path);
  if (!doc) return [];
  return els(doc, NS.s, 'comment').flatMap((cm, i) => {
    const text = firstChildEl(cm, NS.s, 'text');
    if (!text) return [];
    return [markDirtyOnWrite(pkg, path, richTextUnit(text, { part: path, key: `cm${i}`, location: 'comment', where: `${sh.name}!${cm.getAttribute('ref') ?? ''} 註解`, page: sh.index }))];
  });
}

function collectThreaded(pkg: OoxmlPackage, path: string, sh: SheetInfo): TextUnit[] {
  const doc = pkg.xml(path);
  if (!doc) return [];
  return els(doc, NS.tc, 'text').map((t, i) => {
    const ref = t.parentElement?.getAttribute('ref') ?? '';
    return markDirtyOnWrite(pkg, path, elementUnit(t, { part: path, key: `tc${i}`, location: 'comment', where: `${sh.name}!${ref} 討論串註解`, page: sh.index }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Formulas: only string literals are matched/cut, never references ('Confidential Data'!A1 must not be touched).
// ---------------------------------------------------------------------------------------------------------------

interface FormulaToken {
  literal: boolean;
  raw: string;
  text: string;
}

export function tokenizeFormula(f: string): FormulaToken[] {
  const out: FormulaToken[] = [];
  let i = 0;
  let buf = '';
  while (i < f.length) {
    const ch = f[i]!;
    if (ch === "'") {
      // quoted sheet name — copy verbatim
      const j = scanQuoted(f, i, "'");
      buf += f.slice(i, j);
      i = j;
    } else if (ch === '"') {
      if (buf) out.push({ literal: false, raw: buf, text: buf });
      buf = '';
      const j = scanQuoted(f, i, '"');
      const raw = f.slice(i, j);
      out.push({ literal: true, raw, text: raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined).replace(/""/g, '"') });
      i = j;
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) out.push({ literal: false, raw: buf, text: buf });
  return out;
}

function scanQuoted(s: string, start: number, q: string): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === q) {
      if (s[i + 1] === q) i += 2;
      else return i + 1;
    } else i++;
  }
  return s.length;
}

function formulaUnit(touch: () => void, path: string, f: Element, base: { key: string; where: string; page: number }): TextUnit | null {
  const tokens = tokenizeFormula(f.textContent ?? '');
  const segments: Segment[] = [];
  const refs: SegRef[] = [];
  const litIdx: number[] = [];
  tokens.forEach((t, i) => {
    if (!t.literal) return;
    if (segments.length) {
      segments.push({ text: '\n', virtual: true });
      refs.push(null);
    }
    litIdx.push(i);
    segments.push({ text: t.text });
    refs.push(null);
  });
  if (!litIdx.length) return null;
  return {
    part: path,
    key: base.key,
    location: 'formula',
    where: base.where,
    page: base.page,
    segments,
    refs,
    write: (newTexts) => {
      let k = 0;
      newTexts.forEach((t, si) => {
        if (segments[si]!.virtual) return;
        const tok = tokens[litIdx[k++]!]!;
        tok.raw = `"${t.replace(/"/g, '""')}"`;
      });
      f.textContent = tokens.map((t) => t.raw).join('');
      touch();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Header / footer codes: &L &C &R sections, &"Font,Style", &12 size, &KFF0000 colour, &P page … ; && = literal &.
// ---------------------------------------------------------------------------------------------------------------

interface HfToken {
  code: boolean;
  raw: string;
  text: string;
  section?: boolean;
}

export function tokenizeHeaderFooter(s: string): HfToken[] {
  const out: HfToken[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ code: false, raw: '', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== '&') {
      text += ch;
      i++;
      continue;
    }
    const n = s[i + 1];
    if (n === '&') {
      text += '&';
      i += 2;
      continue;
    }
    flush();
    if (n === undefined) {
      out.push({ code: true, raw: '&', text: '' });
      i++;
    } else if (n === '"') {
      const j = s.indexOf('"', i + 2);
      const end = j < 0 ? s.length : j + 1;
      out.push({ code: true, raw: s.slice(i, end), text: '' });
      i = end;
    } else if (/\d/.test(n)) {
      let j = i + 1;
      while (j < s.length && /\d/.test(s[j]!)) j++;
      out.push({ code: true, raw: s.slice(i, j), text: '' });
      i = j;
    } else if (n === 'K') {
      const m = /^&K(?:[0-9A-Fa-f]{6}|\d\d[+-]\d{3}|\d\dS\d{3})/.exec(s.slice(i));
      const len = m ? m[0].length : 2;
      out.push({ code: true, raw: s.slice(i, i + len), text: '' });
      i += len;
    } else {
      out.push({ code: true, raw: s.slice(i, i + 2), text: '', section: n === 'L' || n === 'C' || n === 'R' });
      i += 2;
    }
  }
  flush();
  return out;
}

function headerFooterUnit(touch: () => void, path: string, el: Element, base: { key: string; location: 'header' | 'footer'; where: string; page: number }): TextUnit {
  const tokens = tokenizeHeaderFooter(el.textContent ?? '');
  const segments: Segment[] = tokens.map((t) => (t.code ? { text: t.section ? '\n' : '', virtual: true } : { text: t.text }));
  return {
    part: path,
    key: base.key,
    location: base.location,
    where: base.where,
    page: base.page,
    segments,
    refs: tokens.map(() => null),
    write: (newTexts) => {
      el.textContent = tokens.map((t, i) => (t.code ? t.raw : newTexts[i]!.replace(/&/g, '&&'))).join('');
      touch();
    },
  };
}
