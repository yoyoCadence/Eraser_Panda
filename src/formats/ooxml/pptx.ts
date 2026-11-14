import type { LocationKind } from '../../core/types';
import { chartsOf, collectAltText, collectChart, collectDmlParagraphs } from './drawingml';
import { markDirtyOnWrite } from './metadata';
import type { OoxmlPackage } from './package';
import { attrUnit, elementUnit, partNumber, type TextUnit } from './units';
import { NS, closest, els, firstChildEl } from './xml';

const REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** Placeholder type of the shape that contains a paragraph (footer / header / date / slide number …). */
function placeholderType(p: Element): string | null {
  const sp = closest(p, NS.p, 'sp');
  if (!sp) return null;
  const nvSpPr = firstChildEl(sp, NS.p, 'nvSpPr');
  const nvPr = nvSpPr && firstChildEl(nvSpPr, NS.p, 'nvPr');
  const ph = nvPr && firstChildEl(nvPr, NS.p, 'ph');
  return ph ? (ph.getAttribute('type') ?? 'body') : null;
}

function refineFooter(where: string) {
  return (p: Element): { location?: LocationKind; where?: string } | undefined => {
    const t = placeholderType(p);
    if (t === 'ftr') return { location: 'footer', where: `${where}・頁尾` };
    if (t === 'hdr') return { location: 'header', where: `${where}・頁首` };
    return undefined;
  };
}

export function collectPptx(pkg: OoxmlPackage): TextUnit[] {
  const units: TextUnit[] = [];
  const pres = pkg.rels('').find((r) => r.type === REL_DOC)?.target ?? 'ppt/presentation.xml';
  const slideNo = new Map<string, number>();
  const presDoc = pkg.xml(pres);
  if (presDoc) {
    els(presDoc, NS.p, 'sldId').forEach((el, i) => {
      const target = pkg.relTarget(pres, el.getAttributeNS(NS.r, 'id') ?? '');
      if (target) slideNo.set(target, i + 1);
    });
  }

  for (const path of pkg.paths) {
    const ct = pkg.contentType(path) ?? '';
    let ctx: { location: LocationKind; where: string; page?: number } | null = null;
    if (ct.endsWith('presentationml.slide+xml')) {
      const n = slideNo.get(path);
      ctx = { location: 'body', where: n ? `第 ${n} 張投影片` : `投影片（未顯示：${path}）`, page: n };
    } else if (ct.endsWith('presentationml.slideLayout+xml')) ctx = { location: 'master', where: `版面配置 ${partNumber(path) ?? ''}`.trim() };
    else if (ct.endsWith('presentationml.slideMaster+xml')) ctx = { location: 'master', where: `投影片母片 ${partNumber(path) ?? ''}`.trim() };
    else if (ct.endsWith('presentationml.notesSlide+xml')) {
      const slide = pkg.rels(path).find((r) => /\/slide$/.test(r.type))?.target;
      const n = slide ? slideNo.get(slide) : undefined;
      ctx = { location: 'notes', where: n ? `第 ${n} 張投影片・備忘稿` : '備忘稿', page: n };
    } else if (ct.endsWith('presentationml.notesMaster+xml')) ctx = { location: 'master', where: '備忘稿母片' };
    else if (ct.endsWith('presentationml.handoutMaster+xml')) ctx = { location: 'master', where: '講義母片' };
    else if (ct.includes('drawingml.diagramData+xml') || ct.includes('drawingml.diagramDrawing+xml') || ct.includes('ms-office.drawingml.diagramDrawing+xml')) ctx = { location: 'body', where: 'SmartArt 圖形' };
    else if (ct.endsWith('presentationml.comments+xml')) {
      const doc = pkg.xml(path);
      if (doc) els(doc, NS.p, 'text').forEach((t, i) => units.push(markDirtyOnWrite(pkg, path, elementUnit(t, { part: path, key: `cm${i}`, location: 'comment', where: '投影片註解' }))));
      continue;
    } else if (ct.includes('ms-powerpoint.comments+xml')) ctx = { location: 'comment', where: '投影片註解' };
    if (!ctx) continue;

    units.push(...collectDmlParagraphs(pkg, path, { ...ctx, refine: refineFooter(ctx.where) }));
    units.push(...collectAltText(pkg, path, ctx.where, ctx.page));
    // layout / master names are shown in PowerPoint's layout picker and referenced by nothing else
    if (ctx.location === 'master') {
      const cSld = els(pkg.xml(path)!, NS.p, 'cSld')[0];
      if (cSld?.getAttribute('name')) units.push(markDirtyOnWrite(pkg, path, attrUnit(cSld, 'name', { part: path, key: 'cSld:name', location: 'master', where: `${ctx.where}・名稱` })));
    }
    for (const ch of chartsOf(pkg, path)) units.push(...collectChart(pkg, ch, `${ctx.where}・圖表`, ctx.page));
  }
  return units;
}
