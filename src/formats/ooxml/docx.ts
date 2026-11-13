import type { LocationKind } from '../../core/types';
import { markDirtyOnWrite } from './metadata';
import type { OoxmlPackage } from './package';
import { FALLBACK_NOTE, attrUnit, isInFallback, partNumber, wmlParagraphSegments, type TextUnit } from './units';
import { NS, closest, els, hasAncestor, removeEl } from './xml';

const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';

interface PartKind {
  location: LocationKind;
  name: (path: string) => string;
}

function classify(contentType: string): PartKind | null {
  if (/wordprocessingml\.(document|template)\.main\+xml$|ms-word\.(document|template)\.macroEnabled\.main\+xml$/.test(contentType)) return { location: 'body', name: () => '內文' };
  if (contentType === `${CT}header+xml`) return { location: 'header', name: (p) => `頁首 ${partNumber(p) ?? ''}`.trim() };
  if (contentType === `${CT}footer+xml`) return { location: 'footer', name: (p) => `頁尾 ${partNumber(p) ?? ''}`.trim() };
  if (contentType === `${CT}footnotes+xml`) return { location: 'body', name: () => '註腳' };
  if (contentType === `${CT}endnotes+xml`) return { location: 'body', name: () => '章節附註' };
  if (contentType === `${CT}comments+xml`) return { location: 'comment', name: () => '註解' };
  if (contentType === `${CT}document.glossary+xml`) return { location: 'other', name: () => '建置組塊（快速組件庫）' };
  return null;
}

export function collectDocx(pkg: OoxmlPackage): TextUnit[] {
  const units: TextUnit[] = [];
  for (const path of pkg.paths) {
    const kind = classify(pkg.contentType(path) ?? '');
    if (!kind) continue;
    const doc = pkg.xml(path);
    if (!doc) continue;
    const partName = kind.name(path);
    const inHeaderFooter = kind.location === 'header' || kind.location === 'footer';

    // ---- paragraphs ----
    els(doc, NS.w, 'p').forEach((p, i) => {
      const { segments, refs } = wmlParagraphSegments(p);
      if (!segments.some((s) => !s.virtual && s.text)) return;
      const inTextbox = hasAncestor(p, NS.w, 'txbxContent');
      const location: LocationKind = inHeaderFooter ? kind.location : inTextbox ? 'textbox' : kind.location;
      const deleted = refs.some((r) => r?.el.localName === 'delText');
      const notes = [isInFallback(p) ? FALLBACK_NOTE : '', deleted ? '包含「追蹤修訂」中已刪除但仍存在檔案內的文字' : ''].filter(Boolean);
      units.push(
        markDirtyOnWrite(pkg, path, {
          part: path,
          key: `p${i}`,
          location,
          where: kind.location === 'body' && !inTextbox && partName === '內文' ? `內文第 ${i + 1} 段` : inTextbox ? `${partName}・文字方塊` : partName,
          segments,
          refs,
          note: notes.join('；') || undefined,
          afterWrite: (changed) => unlinkFields(changed),
        }),
      );
    });

    // ---- field codes: { QUOTE "Confidential" }, { IF … "Secret" } — text that is not displayed but is in the file ----
    els(doc, NS.w, 'instrText').forEach((it, i) => {
      if (!it.textContent?.trim()) return;
      units.push(markDirtyOnWrite(pkg, path, { part: path, key: `fld${i}`, location: 'other', where: `${partName}・欄位代碼`, segments: [{ text: it.textContent }], refs: [{ el: it }] }));
    });

    // ---- VML WordArt watermarks (Design → Watermark) ----
    els(doc, NS.v, 'textpath').forEach((tp, i) => {
      if (!tp.getAttribute('string')) return;
      const target = watermarkContainer(tp);
      units.push(
        attrUnit(tp, 'string', {
          part: path,
          key: `wm${i}`,
          location: 'watermark',
          kind: 'watermark',
          where: `浮水印（${partName}）`,
          wholeObject: {
            label: '整個浮水印物件將被移除',
            remove: () => {
              removeEl(target);
              pkg.markDirty(path);
            },
          },
        }),
      );
    });
  }
  return units;
}

/** The element to delete for a watermark: the whole run (incl. mc:AlternateContent wrapper) holding the shape. */
function watermarkContainer(textpath: Element): Element {
  const alt = closest(textpath, NS.mc, 'AlternateContent');
  const run = closest(alt ?? textpath, NS.w, 'r');
  return run ?? alt ?? closest(textpath, NS.v, 'shape') ?? textpath;
}

/**
 * When text inside a field result was edited, convert the field into plain text ("unlink", Ctrl+Shift+F9).
 * Otherwise Word re-evaluates e.g. {DOCPROPERTY Classification} on open/print and the label comes back, or shows
 * "Error! Unknown document property name." because the property was removed too.
 */
export function unlinkFields(changed: readonly Element[]): void {
  for (const t of changed) {
    // Simple field: <w:fldSimple w:instr="DOCPROPERTY X"><w:r><w:t>Confidential</w:t></w:r></w:fldSimple>
    const simple = closest(t, NS.w, 'fldSimple');
    if (simple && simple.parentNode) {
      while (simple.firstChild) simple.parentNode.insertBefore(simple.firstChild, simple);
      removeEl(simple);
      continue;
    }
    // Complex field: runs  begin … instrText … separate … RESULT … end  among the siblings of this run.
    const run = closest(t, NS.w, 'r');
    if (!run || !run.parentElement) continue;
    const siblings = Array.from(run.parentElement.children);
    const idx = siblings.indexOf(run);
    let depth = 0;
    let begin = -1;
    for (let i = idx - 1; i >= 0; i--) {
      const type = fldCharType(siblings[i]!);
      if (type === 'end') depth++;
      else if (type === 'begin') {
        if (depth === 0) {
          begin = i;
          break;
        }
        depth--;
      }
    }
    if (begin < 0) continue;
    depth = 0;
    let sep = -1;
    let end = -1;
    for (let i = begin + 1; i < siblings.length; i++) {
      const type = fldCharType(siblings[i]!);
      if (type === 'begin') depth++;
      else if (type === 'separate' && depth === 0) sep = i;
      else if (type === 'end') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }
    if (sep < 0 || end < 0 || idx <= sep || idx >= end) continue;
    // remove begin..separate (field code) and the end marker; keep the result runs as plain text
    for (let i = begin; i <= sep; i++) removeEl(siblings[i]!);
    removeEl(siblings[end]!);
  }
}

function fldCharType(el: Element): string | null {
  if (el.namespaceURI !== NS.w || el.localName !== 'r') return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.namespaceURI === NS.w && c.localName === 'fldChar') return c.getAttributeNS(NS.w, 'fldCharType') ?? c.getAttribute('w:fldCharType');
  }
  return null;
}
