import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib';
import { lookupArray, lookupDict, nameOf, streamBytes } from '../pdfdoc';
import { loadFont, type FontInfo, type Glyph } from './fonts';
import { parseContent, type Instr, type Obj } from './lexer';

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 in PDF's row-vector convention (apply m1 first, then m2). */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Inverse of an affine matrix, or null when it is singular. */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** A content stream we may rewrite: a page's (concatenated) contents, or a Form XObject. */
export interface Source {
  key: string;
  kind: 'page' | 'form';
  page: number;
  /** form stream reference (kind === 'form') */
  ref?: PDFRef;
  data: Uint8Array;
  instrs: Instr[];
}

export type McKind = 'watermark' | 'header' | 'footer' | null;

export interface TextRun {
  src: Source;
  instr: number;
  /** index of the string inside a TJ array; 0 for Tj / ' / " */
  elem: number;
  glyphs: Glyph[];
  /** per glyph quad in user space: 4 corners [x,y] */
  quads: Array<Array<[number, number]>>;
  start: [number, number];
  end: [number, number];
  /** unit vector of the baseline in user space */
  dir: [number, number];
  /** font size in user space */
  height: number;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  vertical: boolean;
  mc: McKind;
  page: number;
  /** drawn with an invisible rendering mode (OCR text layer) */
  invisible: boolean;
}

/** One painted (or clipping) path: its construction operators, optional W / W* and the painting operator. */
export interface PathPlacement {
  src: Source;
  page: number;
  /** indices of every instruction that belongs to this path */
  instrs: number[];
  /** bounding box of all path points (control points included) in user space: [x1, y1, x2, y2] */
  bbox: [number, number, number, number];
  /** the path also sets the clipping path — never removed (that would reveal clipped content) */
  clip: boolean;
}

export interface ImagePlacement {
  page: number;
  src: Source;
  instr: number;
  /** XObject name in resources, or null for inline images */
  name: string | null;
  ref?: PDFRef;
  /** unit square → user space corners */
  quad: Array<[number, number]>;
  mc: McKind;
}

interface GState {
  ctm: Matrix;
  font: FontInfo | null;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  /** text rendering mode (3 / 7 = invisible: OCR layers of scanned documents) */
  tr: number;
}

/** Every `Do` of a Form XObject: which source drew it and with which matrix (in that source's interpreted space). */
export interface FormCall {
  key: string;
  parent: Source;
  ctm: Matrix;
}

export interface InterpretResult {
  runs: TextRun[];
  images: ImagePlacement[];
  paths: PathPlacement[];
  sources: Source[];
  /** form key → pages where it is used (direct uses only; see `placementsOf` for nested forms) */
  formUses: Map<string, Set<number>>;
  /** form key → the matrix the form was interpreted with (its first use) */
  formBase: Map<string, Matrix>;
  formCalls: FormCall[];
  trackPaths: boolean;
}

/**
 * @param trackPaths record vector paths (only needed for user regions — drawing-heavy PDFs have millions of them)
 */
export function newResult(trackPaths = false): InterpretResult {
  return { runs: [], images: [], paths: [], sources: [], formUses: new Map(), formBase: new Map(), formCalls: [], trackPaths };
}

/** Where a source's content really appears: one entry per drawing on a page. */
export interface Placement {
  page: number;
  /** maps the source's interpreted user-space coordinates to this placement's page coordinates (null: unknown) */
  t: Matrix | null;
}

/**
 * Every placement of a source. Positions computed while interpreting a Form XObject belong to its FIRST use; a form
 * drawn on several pages (or several times, or inside another shared form) appears elsewhere too. This maps the
 * interpreted coordinates to every real occurrence, so highlights and region hit tests are right on every page.
 */
export function placementsOf(res: InterpretResult, src: Source, memo = new Map<string, Placement[]>(), depth = 0): Placement[] {
  if (src.kind === 'page') return [{ page: src.page, t: IDENTITY }];
  const cached = memo.get(src.key);
  if (cached) return cached;
  memo.set(src.key, []); // cycle guard
  const base = res.formBase.get(src.key);
  const inv = base ? invert(base) : null;
  const out: Placement[] = [];
  if (depth < 16)
    for (const call of callsByKey(res).get(src.key) ?? []) {
      for (const p of placementsOf(res, call.parent, memo, depth + 1)) {
        out.push({ page: p.page, t: inv && p.t ? mul(mul(inv, call.ctm), p.t) : null });
      }
    }
  if (!out.length) out.push({ page: src.page, t: IDENTITY });
  memo.set(src.key, out);
  return out;
}

const callIndex = new WeakMap<InterpretResult, Map<string, FormCall[]>>();
function callsByKey(res: InterpretResult): Map<string, FormCall[]> {
  let idx = callIndex.get(res);
  if (!idx || idx.size === 0) {
    idx = new Map();
    for (const c of res.formCalls) {
      const list = idx.get(c.key);
      if (list) list.push(c);
      else idx.set(c.key, [c]);
    }
    callIndex.set(res, idx);
  }
  return idx;
}

/** Sorted distinct pages of a set of placements. */
export function placementPages(list: readonly Placement[]): number[] {
  return [...new Set(list.map((p) => p.page))].sort((a, b) => a - b);
}

/** Interpret one page (and every Form XObject it draws, once per document). */
export function interpretPage(doc: PDFDocument, pageIndex: number, out: InterpretResult): void {
  const page = doc.getPage(pageIndex);
  const node = page.node;
  const contents = node.Contents();
  const parts: Uint8Array[] = [];
  const pushStream = (o: PDFObject | undefined) => {
    const s = o instanceof PDFRef ? doc.context.lookup(o) : o;
    const b = streamBytes(s);
    if (b) parts.push(b);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) pushStream(contents.get(i));
  } else pushStream(contents);
  const data = concat(parts);
  const src: Source = { key: `p${pageIndex + 1}`, kind: 'page', page: pageIndex + 1, data, instrs: parseContent(data) };
  out.sources.push(src);
  run(doc, src, node.Resources(), IDENTITY, out, 0, null);
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a; // streams are concatenated with a separator so tokens never merge
  }
  return out;
}

const numArg = (o: Obj | undefined) => (o && o.t === 'num' ? o.v : 0);

function run(doc: PDFDocument, src: Source, resources: PDFDict | undefined, ctm0: Matrix, out: InterpretResult, depth: number, mc0: McKind): void {
  const fonts = resources ? lookupDict(doc, resources.get(PDFName.of('Font'))) : undefined;
  const xobjects = resources ? lookupDict(doc, resources.get(PDFName.of('XObject'))) : undefined;
  const props = resources ? lookupDict(doc, resources.get(PDFName.of('Properties'))) : undefined;

  let gs: GState = { ctm: ctm0, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0 };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const mcStack: McKind[] = [];
  const mc = () => mcStack.reduce<McKind>((acc, k) => k ?? acc, mc0);
  // current path under construction
  const track = out.trackPaths;
  let pathInstrs: number[] = [];
  let bx1 = Infinity;
  let by1 = Infinity;
  let bx2 = -Infinity;
  let by2 = -Infinity;
  let pathClip = false;
  const pathPoint = (x: number, y: number) => {
    if (!track) return;
    const [px, py] = apply(gs.ctm, x, y);
    if (px < bx1) bx1 = px;
    if (px > bx2) bx2 = px;
    if (py < by1) by1 = py;
    if (py > by2) by2 = py;
  };
  const endPath = (idx: number, painted: boolean) => {
    if (track && pathInstrs.length && painted && bx1 <= bx2) out.paths.push({ src, page: src.page, instrs: [...pathInstrs, idx], bbox: [bx1, by1, bx2, by2], clip: pathClip });
    pathInstrs = [];
    bx1 = by1 = Infinity;
    bx2 = by2 = -Infinity;
    pathClip = false;
  };
  const pathOp = (idx: number) => {
    if (track) pathInstrs.push(idx);
  };

  const show = (bytes: Uint8Array, instr: number, elem: number) => {
    const font = gs.font;
    if (!font) return;
    const glyphs = font.decode(bytes);
    const quads: Array<Array<[number, number]>> = [];
    const trmBase = (): Matrix => mul(mul([gs.fs * gs.th, 0, 0, gs.fs, 0, gs.rise], tm), gs.ctm);
    const t0 = trmBase();
    const start = apply(t0, 0, 0);
    for (const g of glyphs) {
      const trm = trmBase();
      const w = font.vertical ? 1 : g.w0;
      quads.push([apply(trm, 0, font.descent), apply(trm, w, font.descent), apply(trm, w, font.ascent), apply(trm, 0, font.ascent)]);
      if (font.vertical) {
        const ty = -gs.fs + gs.tc + (g.space ? gs.tw : 0);
        tm = mul([1, 0, 0, 1, 0, ty], tm);
      } else {
        const tx = (g.w0 * gs.fs + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    const end = apply(trmBase(), 0, 0);
    const xAxis = apply(t0, 1, 0);
    const yAxis = apply(t0, 0, 1);
    let dx = xAxis[0] - start[0];
    let dy = xAxis[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const height = Math.hypot(yAxis[0] - start[0], yAxis[1] - start[1]);
    out.runs.push({ src, instr, elem, glyphs, quads, start, end, dir: [dx, dy], height, fs: gs.fs, tc: gs.tc, tw: gs.tw, th: gs.th, vertical: font.vertical, mc: mc(), page: src.page, invisible: gs.tr === 3 || gs.tr === 7 });
  };

  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
    tm = tlm;
  };

  src.instrs.forEach((ins, idx) => {
    const a = ins.args;
    switch (ins.op) {
      case 'm':
      case 'l':
        pathOp(idx);
        pathPoint(numArg(a[0]), numArg(a[1]));
        break;
      case 'c':
        pathOp(idx);
        for (let k = 0; k < 6; k += 2) pathPoint(numArg(a[k]), numArg(a[k + 1]));
        break;
      case 'v':
      case 'y':
        pathOp(idx);
        for (let k = 0; k < 4; k += 2) pathPoint(numArg(a[k]), numArg(a[k + 1]));
        break;
      case 're': {
        pathOp(idx);
        const [x, y, w, h] = [numArg(a[0]), numArg(a[1]), numArg(a[2]), numArg(a[3])];
        pathPoint(x, y);
        pathPoint(x + w, y);
        pathPoint(x + w, y + h);
        pathPoint(x, y + h);
        break;
      }
      case 'h':
        if (pathInstrs.length) pathInstrs.push(idx);
        break;
      case 'W':
      case 'W*':
        if (pathInstrs.length) {
          pathInstrs.push(idx);
          pathClip = true;
        }
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        endPath(idx, true);
        break;
      case 'n':
        endPath(idx, false);
        break;
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map(numArg) as Matrix, gs.ctm);
        break;
      case 'BT':
        tm = tlm = IDENTITY;
        break;
      case 'Tf': {
        const fname = a[0]?.t === 'name' ? a[0].v : '';
        gs.font = loadFont(doc, fonts?.get(PDFName.of(fname)));
        gs.fs = numArg(a[1]);
        break;
      }
      case 'Tc':
        gs.tc = numArg(a[0]);
        break;
      case 'Tw':
        gs.tw = numArg(a[0]);
        break;
      case 'Tz':
        gs.th = numArg(a[0]) / 100;
        break;
      case 'TL':
        gs.tl = numArg(a[0]);
        break;
      case 'Tr':
        gs.tr = numArg(a[0]);
        break;
      case 'Ts':
        gs.rise = numArg(a[0]);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, numArg(a[0]), numArg(a[1])], tlm);
        tm = tlm;
        break;
      case 'TD':
        gs.tl = -numArg(a[1]);
        tlm = mul([1, 0, 0, 1, numArg(a[0]), numArg(a[1])], tlm);
        tm = tlm;
        break;
      case 'Tm':
        if (a.length >= 6) tm = tlm = a.slice(0, 6).map(numArg) as Matrix;
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
        if (a[0]?.t === 'str') show(a[0].v, idx, 0);
        break;
      case "'":
        nextLine();
        if (a[0]?.t === 'str') show(a[0].v, idx, 0);
        break;
      case '"':
        gs.tw = numArg(a[0]);
        gs.tc = numArg(a[1]);
        nextLine();
        if (a[2]?.t === 'str') show(a[2].v, idx, 0);
        break;
      case 'TJ': {
        const arr = a[0]?.t === 'arr' ? a[0].v : [];
        arr.forEach((el, k) => {
          if (el.t === 'num') {
            const adj = (-el.v / 1000) * gs.fs;
            tm = gs.font?.vertical ? mul([1, 0, 0, 1, 0, adj], tm) : mul([1, 0, 0, 1, adj * gs.th, 0], tm);
          } else if (el.t === 'str') show(el.v, idx, k);
        });
        break;
      }
      case 'BMC':
        mcStack.push(null);
        break;
      case 'BDC':
        mcStack.push(classifyMarkedContent(doc, a, props));
        break;
      case 'EMC':
        mcStack.pop();
        break;
      case 'Do': {
        const name = a[0]?.t === 'name' ? a[0].v : '';
        const ref = xobjects?.get(PDFName.of(name));
        const xo = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!(xo instanceof PDFRawStream)) break;
        const sub = nameOf(xo.dict.lookup(PDFName.of('Subtype')));
        if (sub === 'Image') {
          out.images.push({ page: src.page, src, instr: idx, name, ref: ref instanceof PDFRef ? ref : undefined, quad: unitQuad(gs.ctm), mc: mc() });
        } else if (sub === 'Form' && depth < 12) {
          const key = ref instanceof PDFRef ? `x${ref.objectNumber}_${ref.generationNumber}` : `${src.key}/${name}`;
          const fm = lookupArray(doc, xo.dict.get(PDFName.of('Matrix')));
          const m: Matrix = fm && fm.size() >= 6 ? ([0, 1, 2, 3, 4, 5].map((k) => (fm.lookup(k) as PDFNumber | undefined)?.asNumber?.() ?? IDENTITY[k]!) as Matrix) : IDENTITY;
          const ctm = mul(m, gs.ctm);
          out.formCalls.push({ key, parent: src, ctm });
          const uses = out.formUses.get(key);
          if (uses) {
            uses.add(src.page);
            break; // interpreted already (first use wins for positions; see placementsOf)
          }
          out.formUses.set(key, new Set([src.page]));
          const bytes = streamBytes(xo);
          if (!bytes) break;
          const formSrc: Source = { key, kind: 'form', page: src.page, ref: ref instanceof PDFRef ? ref : undefined, data: bytes, instrs: parseContent(bytes) };
          out.sources.push(formSrc);
          out.formBase.set(key, ctm);
          const res = lookupDict(doc, xo.dict.get(PDFName.of('Resources'))) ?? resources;
          run(doc, formSrc, res, ctm, out, depth + 1, mc());
        }
        break;
      }
      case 'BI':
        out.images.push({ page: src.page, src, instr: idx, name: null, quad: unitQuad(gs.ctm), mc: mc() });
        break;
    }
  });
}

function unitQuad(ctm: Matrix): Array<[number, number]> {
  return [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
}

/**
 * Marked content used by Acrobat / Word for pagination artifacts:
 *   /Artifact <</Type /Pagination /Subtype /Watermark>> BDC   (watermarks)
 *   /Artifact <</Type /Pagination /Subtype /Header>> BDC      (headers / footers)
 * The property list may be inline or a name looked up in the resources' /Properties.
 */
function classifyMarkedContent(doc: PDFDocument, args: Obj[], props: PDFDict | undefined): McKind {
  const tag = args[0]?.t === 'name' ? args[0].v : '';
  const p = args[1];
  let subtype: string | undefined;
  let type: string | undefined;
  if (p?.t === 'dict') {
    const s = p.v.get('Subtype');
    const t = p.v.get('Type');
    subtype = s?.t === 'name' ? s.v : undefined;
    type = t?.t === 'name' ? t.v : undefined;
  } else if (p?.t === 'name' && props) {
    const d = lookupDict(doc, props.get(PDFName.of(p.v)));
    subtype = nameOf(d?.lookup(PDFName.of('Subtype')));
    type = nameOf(d?.lookup(PDFName.of('Type')));
    // optional content group named like a watermark
    const ocName = d?.lookup(PDFName.of('Name'));
    if (tag === 'OC' && ocName && /watermark|浮水印/i.test(ocName.toString())) return 'watermark';
  }
  if (tag !== 'Artifact') return null;
  if (subtype === 'Watermark') return 'watermark';
  if (subtype === 'Header') return 'header';
  if (subtype === 'Footer') return 'footer';
  if (type === 'Pagination' && !subtype) return 'header';
  return null;
}

/** Visible text of a Form XObject used on its own (e.g. an annotation's appearance stream). */
export function formText(doc: PDFDocument, obj: PDFObject | undefined): string {
  const xo = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(xo instanceof PDFRawStream)) return '';
  const bytes = streamBytes(xo);
  if (!bytes) return '';
  const out = newResult();
  const src: Source = { key: 'appearance', kind: 'form', page: 0, data: bytes, instrs: parseContent(bytes) };
  run(doc, src, lookupDict(doc, xo.dict.get(PDFName.of('Resources'))), IDENTITY, out, 1, null);
  return out.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join(' ');
}
