import { PDFName, PDFRawStream, type PDFDocument } from 'pdf-lib';
import type { Candidate, TextUnit } from '../../../core/candidates';
import { unitCandidates } from '../../../core/candidates';
import type { CompiledRules } from '../../../core/matcher';
import type { Segment } from '../../../core/segments';
import type { LocationKind, NormRect } from '../../../core/types';
import { normRect } from '../pdfdoc';
import type { Glyph } from './fonts';
import { interpretPage, newResult, type InterpretResult, type McKind, type Source, type TextRun } from './interpret';
import { fmtNum, hexString, latin1, type Instr } from './lexer';

/** Removal plan: source key → instruction index → TJ element index → removed glyph indices. */
export type RemovalPlan = Map<string, Map<number, Map<number, Set<number>>>>;

interface Line {
  src: Source;
  runs: TextRun[];
  /** separator before each run ('' | ' ') */
  seps: string[];
}

export interface PdfTextScan {
  result: InterpretResult;
  units: TextUnit[];
  candidates: Candidate[];
  plan: RemovalPlan;
  undecodable: number;
}

export function interpretAll(doc: PDFDocument): InterpretResult {
  const res = newResult();
  for (let i = 0; i < doc.getPageCount(); i++) interpretPage(doc, i, res);
  return res;
}

/** Group runs of each source into visual lines (consecutive in stream order, same baseline). */
function buildLines(res: InterpretResult): Line[] {
  const lines: Line[] = [];
  const bySrc = new Map<Source, TextRun[]>();
  for (const r of res.runs) {
    if (!r.glyphs.length) continue;
    const list = bySrc.get(r.src);
    if (list) list.push(r);
    else bySrc.set(r.src, [r]);
  }
  for (const [src, runs] of bySrc) {
    let cur: Line | null = null;
    let prev: TextRun | null = null;
    for (const r of runs) {
      const rel = prev ? relation(prev, r) : 'new';
      if (rel === 'new' || !cur) {
        cur = { src, runs: [r], seps: [''] };
        lines.push(cur);
      } else {
        cur.runs.push(r);
        cur.seps.push(rel === 'space' ? ' ' : '');
      }
      prev = r;
    }
  }
  return lines;
}

function relation(a: TextRun, b: TextRun): 'new' | 'space' | 'join' {
  const h = Math.max(a.height, b.height, 0.01);
  const angle = Math.abs(Math.atan2(a.dir[1], a.dir[0]) - Math.atan2(b.dir[1], b.dir[0]));
  if (angle > 0.05 && Math.abs(angle - 2 * Math.PI) > 0.05) return 'new';
  const vx = b.start[0] - a.end[0];
  const vy = b.start[1] - a.end[1];
  const perp = Math.abs(a.dir[0] * vy - a.dir[1] * vx);
  const along = a.dir[0] * vx + a.dir[1] * vy;
  if (perp > 0.5 * h || along < -0.5 * h || along > 15 * h) return 'new';
  return along > 0.15 * h ? 'space' : 'join';
}

function lineText(line: Line): { segments: Segment[]; segRun: Array<number | null>; glyphStarts: number[][] } {
  const segments: Segment[] = [];
  const segRun: Array<number | null> = [];
  const glyphStarts: number[][] = [];
  line.runs.forEach((r, i) => {
    if (line.seps[i]) {
      segments.push({ text: line.seps[i]!, virtual: true });
      segRun.push(null);
    }
    let t = '';
    const starts: number[] = [];
    for (const g of r.glyphs) {
      starts.push(t.length);
      t += g.text;
    }
    starts.push(t.length);
    glyphStarts[i] = starts;
    segments.push({ text: t });
    segRun.push(i);
  });
  return { segments, segRun, glyphStarts };
}

function classify(line: Line, rect: NormRect | undefined, formPages: number): { location: LocationKind; label: string } {
  const mcs = new Set<McKind>(line.runs.map((r) => r.mc));
  if (mcs.has('watermark')) return { location: 'watermark', label: '浮水印' };
  const r0 = line.runs[0]!;
  const deg = Math.abs((Math.atan2(r0.dir[1], r0.dir[0]) * 180) / Math.PI) % 90;
  if (deg > 5 && deg < 85) return { location: 'watermark', label: '浮水印（斜向文字）' };
  if (mcs.has('header')) return { location: 'header', label: '頁首' };
  if (mcs.has('footer')) return { location: 'footer', label: '頁尾' };
  if (rect) {
    if (rect.y + rect.h < 0.1) return { location: 'header', label: '頁首' };
    if (rect.y > 0.9) return { location: 'footer', label: '頁尾' };
  }
  if (formPages > 1) return { location: 'header', label: `重複內容（${formPages} 頁）` };
  return { location: 'body', label: '' };
}

function quadsRect(doc: PDFDocument, page: number, quads: Array<Array<[number, number]>>): NormRect | undefined {
  if (!quads.length) return undefined;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const q of quads)
    for (const [x, y] of q) {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
  return normRect(doc, page - 1, [x1, y1, x2, y2]);
}

export function scanPageText(doc: PDFDocument, compiled: CompiledRules): PdfTextScan {
  const result = interpretAll(doc);
  const lines = buildLines(result);
  const units: TextUnit[] = [];
  const plan: RemovalPlan = new Map();
  let undecodable = 0;
  const lineIndex = new Map<Source, number>();
  const meta = new Map<TextUnit, { line: Line; segRun: Array<number | null>; glyphStarts: number[][] }>();

  for (const line of lines) {
    const { segments, segRun, glyphStarts } = lineText(line);
    const text = segments.map((s) => s.text).join('');
    const bad = (text.match(/�/g) ?? []).length;
    if (bad) undecodable += bad;
    const n = lineIndex.get(line.src) ?? 0;
    lineIndex.set(line.src, n + 1);
    const page = line.src.page;
    const allQuads = line.runs.flatMap((r) => r.quads);
    const lineRect = quadsRect(doc, page, allQuads);
    const formPages = line.src.kind === 'form' ? (result.formUses.get(line.src.key)?.size ?? 1) : 1;
    const cls = classify(line, lineRect, formPages);
    const unit: TextUnit = {
      part: line.src.key,
      key: `L${n}`,
      location: cls.location,
      where: `第 ${page} 頁${cls.label ? `・${cls.label}` : ''}${line.src.kind === 'form' && formPages > 1 && !cls.label.includes('頁）') ? `（共 ${formPages} 頁）` : ''}`,
      page,
      kind: cls.location === 'watermark' ? 'watermark' : 'text',
      segments,
      refs: segments.map(() => null),
      note: formPages > 1 ? `此內容是共用物件，會同時從 ${formPages} 頁移除` : undefined,
    };
    units.push(unit);
    meta.set(unit, { line, segRun, glyphStarts });
  }

  const candidates = unitCandidates(units, compiled);
  for (const c of candidates) {
    if (!c.cut) continue;
    const m = meta.get(c.cut.unit)!;
    const quads: Array<Array<[number, number]>> = [];
    const removals: Array<{ run: TextRun; glyph: number }> = [];
    for (const p of c.cut.pieces) {
      const ri = m.segRun[p.seg];
      if (ri === null || ri === undefined) continue;
      const run = m.line.runs[ri]!;
      const starts = m.glyphStarts[ri]!;
      run.glyphs.forEach((g: Glyph, gi) => {
        const gs = starts[gi]!;
        const ge = starts[gi + 1]!;
        // a glyph is removed when any of its characters is inside the cut (ligatures are all-or-nothing);
        // glyphs that map to no text at all are removed when they sit inside the cut
        const hit = ge > gs ? ge > p.start && gs < p.end : gs >= p.start && gs < p.end;
        void g;
        if (hit) {
          removals.push({ run, glyph: gi });
          quads.push(run.quads[gi]!);
        }
      });
    }
    const rect = quadsRect(doc, c.cut.unit.page!, quads);
    if (rect) c.finding.rects = [rect];
    // replace the generic text cut with a glyph-removal plan (content streams are rewritten as a whole later)
    c.cut = undefined;
    c.remove = () => {
      for (const r of removals) addRemoval(plan, r.run, r.glyph);
    };
  }
  return { result, units, candidates, plan, undecodable };
}

function addRemoval(plan: RemovalPlan, run: TextRun, glyph: number): void {
  let bySrc = plan.get(run.src.key);
  if (!bySrc) plan.set(run.src.key, (bySrc = new Map()));
  let byInstr = bySrc.get(run.instr);
  if (!byInstr) bySrc.set(run.instr, (byInstr = new Map()));
  let set = byInstr.get(run.elem);
  if (!set) byInstr.set(run.elem, (set = new Set()));
  set.add(glyph);
}

// ---------------------------------------------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------------------------------------------

/**
 * Apply a removal plan: every affected show instruction is rewritten as a TJ whose removed glyphs are replaced by
 * a position adjustment of exactly their advance, so text after them on the same line does not move.
 * All other bytes of the content stream are kept verbatim.
 */
export function applyPlan(doc: PDFDocument, scan: PdfTextScan): void {
  for (const src of scan.result.sources) {
    const byInstr = scan.plan.get(src.key);
    if (!byInstr || !byInstr.size) continue;
    const runsByInstr = new Map<number, TextRun[]>();
    for (const r of scan.result.runs) if (r.src === src && byInstr.has(r.instr)) runsByInstr.set(r.instr, [...(runsByInstr.get(r.instr) ?? []), r]);

    const chunks: string[] = [];
    let pos = 0;
    const text = latin1(src.data);
    src.instrs.forEach((ins, idx) => {
      const removed = byInstr.get(idx);
      const runs = runsByInstr.get(idx);
      if (!removed || !runs) return;
      chunks.push(text.slice(pos, ins.start));
      chunks.push(rewriteShow(ins, runs, removed, text.slice(ins.start, ins.end)));
      pos = ins.end;
    });
    chunks.push(text.slice(pos));
    const bytes = Uint8Array.from(chunks.join(''), (ch) => ch.charCodeAt(0));
    writeSource(doc, src, bytes);
  }
}

function rewriteShow(ins: Instr, runs: TextRun[], removed: Map<number, Set<number>>, original: string): string {
  const runByElem = new Map(runs.map((r) => [r.elem, r]));
  const items: Array<string | number> = [];
  const pushNum = (n: number) => {
    if (!n) return;
    const last = items[items.length - 1];
    if (typeof last === 'number') items[items.length - 1] = last + n;
    else items.push(n);
  };
  const emitString = (elem: number, original: Uint8Array) => {
    const run = runByElem.get(elem);
    const del = removed.get(elem);
    if (!run || !del || !del.size) {
      items.push(hexString(original));
      return;
    }
    let buf: number[] = [];
    let adv = 0;
    const flush = () => {
      if (adv) {
        pushNum(run.fs ? (-adv / run.fs) * 1000 : 0);
        adv = 0;
      }
    };
    run.glyphs.forEach((g, gi) => {
      if (del.has(gi)) {
        if (buf.length) {
          items.push(hexString(Uint8Array.from(buf)));
          buf = [];
        }
        adv += run.vertical ? -(run.fs - run.tc) : g.w0 * run.fs + run.tc + (g.space ? run.tw : 0);
      } else {
        flush();
        buf.push(...g.bytes);
      }
    });
    if (buf.length) items.push(hexString(Uint8Array.from(buf)));
    flush();
  };

  const a = ins.args;
  let prefix = '';
  if (ins.op === 'TJ' && a[0]?.t === 'arr') {
    a[0].v.forEach((el, k) => {
      if (el.t === 'num') pushNum(el.v);
      else if (el.t === 'str') emitString(k, el.v);
    });
  } else if (ins.op === 'Tj' && a[0]?.t === 'str') emitString(0, a[0].v);
  else if (ins.op === "'" && a[0]?.t === 'str') {
    prefix = 'T* ';
    emitString(0, a[0].v);
  } else if (ins.op === '"' && a[2]?.t === 'str') {
    const aw = a[0]?.t === 'num' ? a[0].v : 0;
    const ac = a[1]?.t === 'num' ? a[1].v : 0;
    prefix = `${fmtNum(aw)} Tw ${fmtNum(ac)} Tc T* `;
    emitString(0, a[2].v);
  } else return original; // not a text-showing instruction we understand — keep verbatim
  const body = items.map((x) => (typeof x === 'number' ? fmtNum(x) : x)).join(' ');
  return `${prefix}[${body}] TJ`;
}

function writeSource(doc: PDFDocument, src: Source, bytes: Uint8Array): void {
  const ctx = doc.context;
  if (src.kind === 'page') {
    const page = doc.getPage(src.page - 1);
    const stream = ctx.flateStream(bytes);
    page.node.set(PDFName.of('Contents'), ctx.register(stream));
    return;
  }
  if (!src.ref) return;
  const old = ctx.lookup(src.ref);
  if (!(old instanceof PDFRawStream)) return;
  const dict: Record<string, unknown> = {};
  for (const [k, v] of old.dict.entries()) {
    const key = k.decodeText();
    if (key === 'Length' || key === 'Filter' || key === 'DecodeParms' || key === 'DL') continue;
    dict[key] = v;
  }
  ctx.assign(src.ref, ctx.flateStream(bytes, dict as never));
}
