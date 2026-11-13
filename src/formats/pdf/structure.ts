import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib';
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
