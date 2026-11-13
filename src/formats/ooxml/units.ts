import type { Segment } from '../../core/segments';
import type { SegRef, TextUnit } from '../../core/candidates';
import { NS, childEls, hasAncestor } from './xml';

export { applyCandidates, preserveSpace, unitCandidates, type Candidate, type SegRef, type TextUnit } from '../../core/candidates';

// ---------------------------------------------------------------------------------------------------------------
// Unit builders
// ---------------------------------------------------------------------------------------------------------------

/**
 * Word paragraph → segments. Text of nested paragraphs (text boxes inside a run) is excluded: those paragraphs
 * are units of their own.
 */
export function wmlParagraphSegments(p: Element): { segments: Segment[]; refs: SegRef[] } {
  const segments: Segment[] = [];
  const refs: SegRef[] = [];
  const walk = (el: Element) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.namespaceURI === NS.w) {
        switch (c.localName) {
          case 'p':
          case 'txbxContent':
            continue; // nested paragraphs are separate units
          case 't':
          case 'delText':
            segments.push({ text: c.textContent ?? '' });
            refs.push({ el: c });
            continue;
          case 'tab':
          case 'br':
          case 'cr':
            if (el.localName === 'r') {
              segments.push({ text: ' ', virtual: true });
              refs.push(null);
            }
            continue;
          case 'instrText':
          case 'rPr':
          case 'pPr':
            continue;
        }
      }
      // VML / DrawingML wrappers can contain w:txbxContent deeper down — keep walking, the switch above stops there.
      walk(c);
    }
  };
  walk(p);
  return { segments, refs };
}

/** DrawingML paragraph (a:p) → segments: a:r/a:t and a:fld/a:t, a:br as a virtual space. */
export function dmlParagraphSegments(p: Element): { segments: Segment[]; refs: SegRef[] } {
  const segments: Segment[] = [];
  const refs: SegRef[] = [];
  for (const c of childEls(p, NS.a)) {
    if (c.localName === 'r' || c.localName === 'fld') {
      for (const t of childEls(c, NS.a, 't')) {
        segments.push({ text: t.textContent ?? '' });
        refs.push({ el: t });
      }
    } else if (c.localName === 'br') {
      segments.push({ text: ' ', virtual: true });
      refs.push(null);
    }
  }
  return { segments, refs };
}

/** A unit made of a single element's text content. */
export function elementUnit(el: Element, base: Omit<TextUnit, 'segments' | 'refs'>): TextUnit {
  return { ...base, segments: [{ text: el.textContent ?? '' }], refs: [{ el }] };
}

/** A unit made of a single attribute value. */
export function attrUnit(el: Element, attr: string, base: Omit<TextUnit, 'segments' | 'refs'>): TextUnit {
  return { ...base, segments: [{ text: el.getAttribute(attr) ?? '' }], refs: [{ el, attr }] };
}

export const FALLBACK_NOTE = '相容性備份副本（舊版 Office 顯示用），與主要版本內容相同';

export function isInFallback(el: Element): boolean {
  return hasAncestor(el, NS.mc, 'Fallback');
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `word/header2.xml` → 2 */
export function partNumber(path: string): number | undefined {
  const m = /(\d+)\.xml$/.exec(path);
  return m ? Number(m[1]) : undefined;
}
