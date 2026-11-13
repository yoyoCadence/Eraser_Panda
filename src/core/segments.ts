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

export function matchSegments(segments: readonly Segment[], compiled: CompiledRules): SegmentHit[] {
  const { joined, offsets } = joinSegments(segments);
  const hits = findHits(joined, compiled);
  return hits.map((h) => ({
    ...h,
    pieces: mapToPieces(segments, offsets, h.start, h.end),
    context: makeContext(joined, h.start, h.end),
    wholeUnit: isWholeUnit(joined, h.start, h.end),
  }));
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
