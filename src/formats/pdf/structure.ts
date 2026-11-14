import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib';
import type { Candidate, TextUnit } from '../../core/candidates';
import { findHits, type CompiledRules } from '../../core/matcher';
import { formText } from './content/interpret';
import { lookupArray, lookupDict, nameOf, normRect, pdfText, toPdfString } from './pdfdoc';

/** Standard stamp names (ISO 32000 12.5.6.12) that are classification labels. */
const LABEL_STAMPS = new Set(['Confidential', 'TopSecret', 'NotForPublicRelease', 'ForComment', 'Final', 'Draft', 'Departmental']);
const LABEL_STAMP_ONLY = new Set(['Confidential', 'TopSecret', 'NotForPublicRelease', 'Departmental']);

const SUBTYPE_LABEL: Record<string, string> = {
  Stamp: '圖章',
  FreeText: '文字方塊',
  Text: '便利貼',
  Watermark: '浮水印',
  Highlight: '螢光標示',
  Square: '方框',
  Circle: '圓框',
  Ink: '手繪',
  FileAttachment: '附件',
  Widget: '表單欄位',
};

export function scanAnnotations(doc: PDFDocument, compiled: CompiledRules): Candidate[] {
  const out: Candidate[] = [];
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const a = lookupDict(doc, ref);
      if (!a) continue;
      const subtype = nameOf(a.lookup(PDFName.of('Subtype'))) ?? '';
      if (subtype === 'Link' || subtype === 'Popup' || subtype === 'Widget') continue;
      const texts = ['Contents', 'T', 'Subj', 'RC'].map((k) => pdfText(a.lookup(PDFName.of(k))) ?? '').filter(Boolean);
      const stampName = subtype === 'Stamp' ? nameOf(a.lookup(PDFName.of('Name'))) : undefined;
      const stampLabel = stampName && LABEL_STAMP_ONLY.has(stampName);
      let hits = texts.flatMap((t) => findHits(t.replace(/<[^>]*>/g, ' '), compiled));
      let fromAppearance = false;
      if (!hits.length && !stampLabel) {
        // custom stamps / watermark annotations carry their text only in the appearance stream
        const ap = lookupDict(doc, a.get(PDFName.of('AP')));
        const normal = ap?.get(PDFName.of('N'));
        const states = lookupDict(doc, normal);
        const streams = states && !(doc.context.lookup(normal as PDFRef) instanceof PDFRawStream) ? states.entries().map(([, v]) => v) : normal ? [normal] : [];
        const apText = streams.map((st) => formText(doc, st)).join(' ');
        hits = findHits(apText, compiled);
        fromAppearance = hits.length > 0;
      }
      const isAttachment = subtype === 'FileAttachment';
      if (!stampLabel && !hits.length && !isAttachment) continue;

      const label = SUBTYPE_LABEL[subtype] ?? subtype;
      const rect = lookupArray(doc, a.get(PDFName.of('Rect')));
      const nums = rect ? [0, 1, 2, 3].map((k) => (rect.get(k) as PDFNumber | undefined)?.asNumber?.() ?? 0) : undefined;
      const match = stampName && LABEL_STAMPS.has(stampName) ? `${stampName} 圖章` : hits[0]?.text ?? label;
      const snippet = texts[0] ?? '';
      out.push({
        finding: {
          id: `p${pi + 1}#annot:${i}`,
          kind: subtype === 'Watermark' ? 'watermark' : 'annotation',
          location: subtype === 'Watermark' ? 'watermark' : 'annotation',
          ruleId: hits[0]?.ruleId,
          matchText: match,
          context: hits.length ? { before: `${label}註解：`, match: hits[0]!.text, after: snippet.length > 60 ? '…' : '' } : { before: `${label}註解：`, match, after: '' },
          where: `第 ${pi + 1} 頁・${label}註解`,
          page: pi + 1,
          rects: nums ? [normRect(doc, pi, nums as [number, number, number, number])] : undefined,
          confidence: stampLabel ? 'high' : 'medium',
          removable: true,
          defaultSelected: true,
          note: isAttachment && !hits.length ? '附件註解可能夾帶含標籤的原始檔，整個註解（含附件）將被移除' : fromAppearance ? '字眼位於註解的外觀圖形中，整個註解將被移除' : '整個註解將被移除',
        },
        remove: () => removeAnnot(doc, page.node.Annots(), ref, a),
      });
    }
  });
  return out;
}

function removeAnnot(doc: PDFDocument, annots: PDFArray | undefined, ref: PDFObject, annot: PDFDict): void {
  if (!annots) return;
  const popup = annot.get(PDFName.of('Popup'));
  for (let i = annots.size() - 1; i >= 0; i--) {
    const item = annots.get(i);
    if (item === ref || (popup && item === popup)) annots.remove(i);
    else if (popup instanceof PDFRef && item instanceof PDFRef && item.toString() === popup.toString()) annots.remove(i);
  }
  // annotations reply to each other via /IRT — orphaned replies are harmless and removed by garbage collection
  void doc;
}

/** Bookmark titles. */
export function scanOutlines(doc: PDFDocument): TextUnit[] {
  const units: TextUnit[] = [];
  const root = lookupDict(doc, doc.catalog.get(PDFName.of('Outlines')));
  if (!root) return units;
  const seen = new Set<PDFDict>();
  let n = 0;
  const walk = (first: PDFObject | undefined, depth: number) => {
    let item = lookupDict(doc, first);
    while (item && !seen.has(item) && depth < 32) {
      seen.add(item);
      const node = item;
      const title = pdfText(node.lookup(PDFName.of('Title')));
      if (title) {
        units.push({
          part: 'outline',
          key: `o${n++}`,
          location: 'bookmark',
          where: `書籤：${title.length > 30 ? `${title.slice(0, 30)}…` : title}`,
          segments: [{ text: title }],
          refs: [null],
          write: ([t]) => node.set(PDFName.of('Title'), toPdfString(t!)),
        });
      }
      walk(node.get(PDFName.of('First')), depth + 1);
      item = lookupDict(doc, node.get(PDFName.of('Next')));
    }
  };
  walk(root.get(PDFName.of('First')), 0);
  return units;
}

/**
 * Document-level attachments (Catalog /Names /EmbeddedFiles name tree).
 * Removal only marks entries; call the returned `finalize()` once after all removals to rebuild the name tree.
 */
export function scanAttachments(doc: PDFDocument): { candidates: Candidate[]; finalize: () => void } {
  const names = lookupDict(doc, doc.catalog.get(PDFName.of('Names')));
  const tree = names && lookupDict(doc, names.get(PDFName.of('EmbeddedFiles')));
  if (!names || !tree) return { candidates: [], finalize: () => {} };
  const out: Candidate[] = [];
  const removed = new Set<string>();
  const leaves: Array<{ arr: PDFArray; index: number; name: string }> = [];
  const walk = (node: PDFDict, depth: number) => {
    const arr = lookupArray(doc, node.get(PDFName.of('Names')));
    if (arr) for (let i = 0; i + 1 < arr.size(); i += 2) leaves.push({ arr, index: i, name: fileName(doc, arr.get(i + 1)) ?? pdfText(arr.lookup(i)) ?? `附件 ${leaves.length + 1}` });
    const kids = lookupArray(doc, node.get(PDFName.of('Kids')));
    if (kids && depth < 16) for (let i = 0; i < kids.size(); i++) {
      const k = lookupDict(doc, kids.get(i));
      if (k) walk(k, depth + 1);
    }
  };
  walk(tree, 0);
  leaves.forEach((leaf, i) => {
    out.push({
      finding: {
        id: `catalog#attachment:${i}`,
        kind: 'metadata',
        location: 'other',
        matchText: leaf.name,
        context: { before: '內嵌附件：', match: leaf.name, after: '' },
        where: '文件附件',
        confidence: 'medium',
        removable: true,
        defaultSelected: true,
        note: '附件的內容不會被檢查（可能是含標籤的原始檔），建議移除',
      },
      remove: () => removed.add(`${i}`),
    });
  });
  const finalize = () => {
    if (!removed.size) return;
    // remove marked pairs, highest index first per array so indices stay valid
    const marked = leaves.map((l, i) => ({ ...l, i })).filter((l) => removed.has(`${l.i}`));
    marked.sort((a, b) => b.index - a.index);
    for (const m of marked) {
      m.arr.remove(m.index + 1);
      m.arr.remove(m.index);
    }
    if (removed.size === leaves.length) names.delete(PDFName.of('EmbeddedFiles'));
  };
  return { candidates: out, finalize };
}

function fileName(doc: PDFDocument, spec: PDFObject | undefined): string | undefined {
  const d = lookupDict(doc, spec);
  if (!d) return undefined;
  return pdfText(d.lookup(PDFName.of('UF'))) ?? pdfText(d.lookup(PDFName.of('F')));
}

/**
 * AcroForm fields: values (/V, /DV), tooltips (/TU) and choice options (/Opt).
 * A changed field also loses its appearance streams (they still draw the old value) and the form is flagged
 * /NeedAppearances so viewers redraw it from the cleaned value.
 */
export function scanFormFields(doc: PDFDocument): { units: TextUnit[]; finalize: () => void; warnings: string[] } {
  const units: TextUnit[] = [];
  const warnings: string[] = [];
  const af = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const fields = af && lookupArray(doc, af.get(PDFName.of('Fields')));
  if (!af || !fields) return { units, finalize: () => {}, warnings };
  if (af.get(PDFName.of('XFA'))) warnings.push('此 PDF 含 XFA 動態表單資料，其中的內容不會被檢查。');

  const touched = new Set<PDFDict>();
  const seen = new Set<PDFDict>();
  const usedKeys = new Map<string, number>();
  const keyFor = (k: string) => {
    const n = usedKeys.get(k) ?? 0;
    usedKeys.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  };
  const stringUnit = (field: PDFDict, name: string, label: string, get: () => string | undefined, set: (t: string) => void) => {
    const value = get();
    if (!value?.trim()) return;
    units.push({
      part: 'form',
      key: keyFor(`${name}:${label}`),
      location: 'formField',
      where: `表單欄位「${name || '（未命名）'}」${label === 'V' || label === 'DV' ? '' : label === 'TU' ? '・提示文字' : '・選項'}`,
      segments: [{ text: value }],
      refs: [null],
      write: ([t]) => {
        set(t!);
        touched.add(field);
      },
    });
  };

  const walk = (ref: PDFObject | undefined, parent: string, depth: number) => {
    const d = lookupDict(doc, ref);
    if (!d || seen.has(d) || depth > 32) return;
    seen.add(d);
    const t = pdfText(d.lookup(PDFName.of('T')));
    const name = t ? (parent ? `${parent}.${t}` : t) : parent;
    for (const key of ['V', 'DV', 'TU']) {
      const k = PDFName.of(key);
      const v = d.lookup(k);
      if (v instanceof PDFArray) {
        for (let i = 0; i < v.size(); i++) stringUnit(d, name, key, () => pdfText(v.lookup(i)), (s) => v.set(i, toPdfString(s)));
      } else stringUnit(d, name, key, () => pdfText(v), (s) => d.set(k, toPdfString(s)));
    }
    const opt = lookupArray(doc, d.get(PDFName.of('Opt')));
    if (opt) {
      for (let i = 0; i < opt.size(); i++) {
        const o = opt.lookup(i);
        if (o instanceof PDFArray) {
          // [export value, display text]
          for (let j = 0; j < o.size(); j++) stringUnit(d, name, 'Opt', () => pdfText(o.lookup(j)), (s) => o.set(j, toPdfString(s)));
        } else stringUnit(d, name, 'Opt', () => pdfText(o), (s) => opt.set(i, toPdfString(s)));
      }
    }
    const kids = lookupArray(doc, d.get(PDFName.of('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), name, depth + 1);
  };
  for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', 0);

  const finalize = () => {
    if (!touched.size) return;
    for (const field of touched) {
      // the field itself may be a widget (merged dictionary), and widget kids carry their own appearance
      field.delete(PDFName.of('AP'));
      const kids = lookupArray(doc, field.get(PDFName.of('Kids')));
      if (kids)
        for (let i = 0; i < kids.size(); i++) {
          const w = lookupDict(doc, kids.get(i));
          if (w && !w.get(PDFName.of('T'))) w.delete(PDFName.of('AP'));
        }
    }
    af.set(PDFName.of('NeedAppearances'), PDFBool.True);
  };
  return { units, finalize, warnings };
}

/**
 * Tagged-PDF structure tree: accessibility text that screen readers and text extractors read —
 * /Alt (alternative description, e.g. of a logo), /ActualText (replacement text), /T (title), /E (expansion).
 */
export function scanStructTree(doc: PDFDocument): TextUnit[] {
  const root = lookupDict(doc, doc.catalog.get(PDFName.of('StructTreeRoot')));
  if (!root) return [];
  const units: TextUnit[] = [];
  const seen = new Set<PDFDict>();
  const LABEL: Record<string, string> = { Alt: '替代文字', ActualText: '實際文字', T: '標題', E: '縮寫展開' };
  let n = 0;
  let budget = 200_000; // pathological trees
  const walk = (o: PDFObject | undefined, depth: number) => {
    if (budget-- <= 0 || depth > 200) return;
    const arr = lookupArray(doc, o);
    if (arr) {
      for (let i = 0; i < arr.size(); i++) walk(arr.get(i), depth + 1);
      return;
    }
    const d = lookupDict(doc, o);
    if (!d || seen.has(d)) return;
    seen.add(d);
    for (const key of Object.keys(LABEL)) {
      const k = PDFName.of(key);
      const value = pdfText(d.lookup(k));
      if (!value?.trim()) continue;
      const type = nameOf(d.lookup(PDFName.of('S'))) ?? '';
      units.push({
        part: 'struct',
        key: `s${n++}:${key}`,
        location: 'other',
        where: `無障礙標籤・${LABEL[key]}${type ? `（${type}）` : ''}`,
        segments: [{ text: value }],
        refs: [null],
        write: ([t]) => d.set(k, toPdfString(t!)),
      });
    }
    walk(d.get(PDFName.of('K')), depth + 1);
  };
  walk(root.get(PDFName.of('K')), 0);
  return units;
}
