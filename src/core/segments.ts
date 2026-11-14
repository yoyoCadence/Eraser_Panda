import { findHits, type CompiledRules, type Hit } from './matcher';

/**
 * Cross-segment matching.
 *
 * Real documents split visible text into many pieces: Word splits "Confidential" into runs "Confi" + "dential"
 * (spell-check, revision ids), PDFs draw words glyph by glyph. A "segment" is one such piece. Segments of one
 * logical unit (a paragraph, a text object) are joined, matched as one string, and each hit is mapped back to
 * per-segment ranges so the caller can cut exactly those characters out of each piece.
 *
 * Segments with `virtual: true` only exist for matching (e.g. an inferred space between two PDF text runs);
 * they are never part of a removal.
 */
export interface Segment {
  text: string;
  virtual?: boolean;
}

export interface Piece {
  seg: number;
  start: number;
  end: number;
}

export interface Context {
  before: string;
  match: string;
  after: string;
}

export interface SegmentHit extends Hit {
  pieces: Piece[];
  context: Context;
  /** true when the hit is (almost) the entire unit, e.g. a footer paragraph that only says "CONFIDENTIAL". */
  wholeUnit: boolean;
}

const CONTEXT_CHARS = 40;

export function joinSegments(segments: readonly Segment[]): { joined: string; offsets: number[] } {
  const offsets: number[] = [];
  let joined = '';
  for (const s of segments) {
    offsets.push(joined.length);
    joined += s.text;
  }
  return { joined, offsets };
}

/**
 * How much surrounding text a removal may take with it:
 *   'full'   — whitespace, separators, brackets (prose: headers, paragraphs, PDF lines)
 *   'spaces' — one adjacent space only (delimited data such as CSV, where a separator is structure, not prose)
 *   'none'   — exactly the hit
 */
export type TidyMode = 'full' | 'spaces' | 'none';

export function matchSegments(segments: readonly Segment[], compiled: CompiledRules, tidy: TidyMode = 'full'): SegmentHit[] {
  const { joined, offsets } = joinSegments(segments);
  const hits = findHits(joined, compiled);
  let lastEnd = 0;
  return hits.map((h) => {
    let [cs, ce] = tidy === 'full' ? tidyRange(joined, h.start, h.end) : tidy === 'spaces' ? tidySpaces(joined, h.start, h.end) : [h.start, h.end];
    // widened ranges of neighbouring hits must never overlap (a character can only be cut once)
    cs = Math.max(cs, lastEnd);
    lastEnd = ce;
    return {
      ...h,
      pieces: mapToPieces(segments, offsets, cs, ce),
      context: makeContext(joined, h.start, h.end),
      wholeUnit: isWholeUnit(joined, h.start, h.end),
    };
  });
}

const WS = /[ \t\u00a0\u3000]/;
const SEP = /[|｜·•\/–—\-,，、;；:：]/;
/** Separators that may be absorbed on the LEFT of a hit — never colons: "Status: Secret" → "Status:" */
const SEP_LEFT = /[|｜·•\/–—\-,，、;；]/;
const END_PUNCT = /[.,;:!?。、，；：！？]/;
const OPEN = '([{（【「『《〈';
const CLOSE = ')]}）】」』》〉';

/**
 * Widen a removal so the remaining text reads naturally:
 *   "a SECRET b" → "a b"         "SECRET b" → "b"           "a SECRET" → "a"
 *   "is secret." → "is."          "Budget (Secret)" → "Budget"
 *   "Secret | Internal | Page 1" → "Page 1"                   "numbers - Secret" → "numbers"
 *   "本文件，請勿外傳。" → "本文件。"
 * Only whitespace, separators and brackets directly around the hit are ever absorbed.
 */
export function tidyRange(text: string, start: number, end: number): [number, number] {
  let ls = start;
  while (ls > 0 && WS.test(text[ls - 1]!)) ls--;
  let re = end;
  while (re < text.length && WS.test(text[re]!)) re++;
  const L = ls > 0 ? text[ls - 1]! : null;
  const R = re < text.length ? text[re]! : null;
  const skipWsRight = (i: number) => {
    while (i < text.length && WS.test(text[i]!)) i++;
    return i;
  };
  const skipWsLeft = (i: number) => {
    while (i > 0 && WS.test(text[i - 1]!)) i--;
    return i;
  };

  // "(Secret)" → drop the brackets too, plus one space before them
  if (L !== null && R !== null && OPEN.includes(L) && OPEN.indexOf(L) === CLOSE.indexOf(R)) {
    const s = ls - 1;
    const e = re + 1;
    if (s > 0 && WS.test(text[s - 1]!) && (e >= text.length || WS.test(text[e]!) || END_PUNCT.test(text[e]!))) return [s - 1, e];
    return [s, e];
  }
  // label at the start of a list: "Secret | Page 1", or between separators: "A | Secret | B"
  if (R !== null && SEP.test(R) && (L === null || SEP.test(L))) return [L === null ? 0 : start, skipWsRight(re + 1)];
  // label at the end after a separator: "numbers - Secret", "本文件，請勿外傳"
  if (L !== null && SEP_LEFT.test(L) && (R === null || END_PUNCT.test(R))) return [skipWsLeft(ls - 1), end];
  // "is secret." → "is."
  if (R !== null && END_PUNCT.test(R) && re === end && ls < start) return [ls, end];
  return tidySpaces(text, start, end, WS);
}

/** Spaces only — a tab is a column separator in TSV. */
const SPACE = /[ \u00a0\u3000]/;

/** Absorb at most one adjacent space ("a SECRET b" → "a b"), never separators, brackets or tabs. */
export function tidySpaces(text: string, start: number, end: number, ws: RegExp = SPACE): [number, number] {
  const before = start === 0 ? null : text[start - 1]!;
  const after = end >= text.length ? null : text[end]!;
  if (after !== null && ws.test(after) && (before === null || ws.test(before))) return [start, end + 1];
  if (after === null && before !== null && ws.test(before)) return [start - 1, end];
  return [start, end];
}

function mapToPieces(segments: readonly Segment[], offsets: number[], start: number, end: number): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s0 = offsets[i]!;
    const s1 = s0 + segments[i]!.text.length;
    if (s1 <= start || s0 >= end || segments[i]!.virtual) continue;
    pieces.push({ seg: i, start: Math.max(start, s0) - s0, end: Math.min(end, s1) - s0 });
  }
  return pieces;
}

const squash = (s: string) => s.replace(/\s+/g, ' ');

export function makeContext(text: string, start: number, end: number): Context {
  let before = squash(text.slice(Math.max(0, start - CONTEXT_CHARS * 2), start));
  let after = squash(text.slice(end, end + CONTEXT_CHARS * 2));
  if (before.length > CONTEXT_CHARS) before = '…' + before.slice(-CONTEXT_CHARS);
  if (after.length > CONTEXT_CHARS) after = after.slice(0, CONTEXT_CHARS) + '…';
  return { before, match: text.slice(start, end), after };
}

/** Nothing but whitespace / punctuation / symbols left around the hit. */
export function isWholeUnit(text: string, start: number, end: number): boolean {
  const rest = text.slice(0, start) + text.slice(end);
  return !/[\p{L}\p{N}]/u.test(rest);
}

/**
 * Apply removals to segment texts. `pieces` may come from several hits; ranges in one segment must not overlap
 * (findHits guarantees non-overlapping hits). Returns new texts; untouched segments keep their identity.
 */
export function cutPieces(texts: readonly string[], pieces: readonly Piece[]): string[] {
  const bySeg = new Map<number, Piece[]>();
  for (const p of pieces) {
    const list = bySeg.get(p.seg);
    if (list) list.push(p);
    else bySeg.set(p.seg, [p]);
  }
  const out = texts.slice();
  for (const [seg, list] of bySeg) {
    list.sort((a, b) => b.start - a.start);
    let t = out[seg]!;
    for (const p of list) t = t.slice(0, p.start) + t.slice(p.end);
    out[seg] = t;
  }
  return out;
}
