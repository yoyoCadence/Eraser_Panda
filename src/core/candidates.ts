import type { CompiledRules } from './matcher';
import { cutPieces, matchSegments, type Piece, type Segment } from './segments';
import type { Confidence, Finding, FindingKind, LocationKind } from './types';

/**
 * Format-agnostic "text unit → candidate removal" model shared by the OOXML and PDF engines.
 */

/** Where one segment's text lives in an XML DOM. `null` for virtual segments or units with a custom `write`. */
export type SegRef = { el: Element; attr?: string } | null;

/**
 * A logical run of text that is matched as one string: a Word paragraph, a DrawingML paragraph, a shared string,
 * an Excel header section, a property value …
 */
export interface TextUnit {
  part: string;
  /** Stable key within the part (document-order index), e.g. `p12`, `si3`, `hf:oddHeader`. */
  key: string;
  location: LocationKind;
  where: string;
  page?: number;
  kind?: FindingKind;
  segments: Segment[];
  refs: SegRef[];
  /** Custom writer (Excel header codes, formula literals). Default: write each changed text back to its ref. */
  write?: (newTexts: string[]) => void;
  /** Called after the unit's text was modified (e.g. unlink Word fields so they do not re-populate). */
  afterWrite?: (changedRefs: Element[]) => void;
  /** If set, any hit removes this whole object (e.g. a VML WordArt watermark) instead of cutting text. */
  wholeObject?: { remove: () => void; label: string };
  note?: string;
  /** Extra confidence override (e.g. header/footer/watermark text is always a label). */
  confidence?: Confidence;
}

/** A finding plus the closure that removes it from the loaded package. */
export interface Candidate {
  finding: Finding;
  /** Text cut (grouped per unit at apply time). */
  cut?: { unit: TextUnit; pieces: Piece[] };
  /** Object removal (runs after all text cuts). */
  remove?: () => void;
  /** Set by apply() when this candidate was selected (lets nested packages know they must be re-saved). */
  touched?: boolean;
}

const LABEL_LOCATIONS = new Set<LocationKind>(['header', 'footer', 'watermark', 'master', 'label']);

export function unitCandidates(units: readonly TextUnit[], compiled: CompiledRules, idPrefix = ''): Candidate[] {
  const out: Candidate[] = [];
  for (const unit of units) {
    if (!unit.segments.some((s) => !s.virtual && s.text)) continue;
    const hits = matchSegments(unit.segments, compiled);
    if (hits.length === 0) continue;
    const base = `${idPrefix}${unit.part}#${unit.key}`;

    if (unit.wholeObject) {
      const text = unit.segments.map((s) => s.text).join('');
      out.push({
        finding: {
          id: `${base}:obj`,
          kind: unit.kind ?? 'watermark',
          location: unit.location,
          ruleId: hits[0]!.ruleId,
          matchText: text,
          context: { before: '', match: text, after: '' },
          where: unit.where,
          page: unit.page,
          part: unit.part,
          confidence: 'high',
          removable: true,
          defaultSelected: true,
          note: unit.wholeObject.label,
        },
        remove: unit.wholeObject.remove,
      });
      continue;
    }

    for (const h of hits) {
      const confidence: Confidence = unit.confidence ?? (LABEL_LOCATIONS.has(unit.location) || h.wholeUnit ? 'high' : unit.location === 'body' ? 'medium' : 'medium');
      out.push({
        finding: {
          id: `${base}:${h.start}-${h.end}`,
          kind: unit.kind ?? 'text',
          location: unit.location,
          ruleId: h.ruleId,
          matchText: h.text,
          context: h.context,
          where: unit.where,
          page: unit.page,
          part: unit.part,
          confidence,
          removable: true,
          defaultSelected: true,
          note: unit.note ?? (unit.location === 'body' && !h.wholeUnit ? '位於內文語句中，刪除可能改變語意' : undefined),
        },
        cut: { unit, pieces: h.pieces },
      });
    }
  }
  return out;
}

/** Apply the selected candidates: all text cuts first (grouped per unit), then object removals. */
export function applyCandidates(selected: readonly Candidate[]): void {
  const byUnit = new Map<TextUnit, Piece[]>();
  for (const c of selected) {
    if (!c.cut) continue;
    const list = byUnit.get(c.cut.unit);
    if (list) list.push(...c.cut.pieces);
    else byUnit.set(c.cut.unit, [...c.cut.pieces]);
  }
  for (const [unit, pieces] of byUnit) {
    const before = unit.segments.map((s) => s.text);
    const after = cutPieces(before, pieces);
    if (unit.write) {
      unit.write(after);
    } else {
      const changed: Element[] = [];
      after.forEach((t, i) => {
        const ref = unit.refs[i];
        if (!ref || t === before[i]) return;
        if (ref.attr) ref.el.setAttribute(ref.attr, t);
        else {
          ref.el.textContent = t;
          preserveSpace(ref.el);
        }
        changed.push(ref.el);
      });
      unit.afterWrite?.(changed);
    }
  }
  for (const c of selected) c.remove?.();
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Word / Excel trim leading+trailing spaces in text elements unless xml:space="preserve". */
export function preserveSpace(el: Element): void {
  if (el.localName === 't' || el.localName === 'delText' || el.localName === 'instrText') {
    el.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  }
}
