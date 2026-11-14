import type { LocationKind } from '../../core/types';
import { markDirtyOnWrite } from './metadata';
import type { OoxmlPackage } from './package';
import { FALLBACK_NOTE, attrUnit, dmlParagraphSegments, elementUnit, isInFallback, type TextUnit } from './units';
import { NS, closest, els, firstChildEl } from './xml';

export interface DmlContext {
  location: LocationKind;
  where: string;
  page?: number;
  /** Map a paragraph to a more specific location (e.g. PowerPoint footer placeholders). */
  refine?: (p: Element) => { location?: LocationKind; where?: string } | undefined;
}

/** Every DrawingML paragraph (a:p) in a part: shapes, text boxes, SmartArt, chart titles … */
export function collectDmlParagraphs(pkg: OoxmlPackage, path: string, ctx: DmlContext, keyPrefix = 'a'): TextUnit[] {
  const doc = pkg.xml(path);
  if (!doc) return [];
  const units: TextUnit[] = [];
  els(doc, NS.a, 'p').forEach((p, i) => {
    const { segments, refs } = dmlParagraphSegments(p);
    if (!segments.some((s) => !s.virtual && s.text)) return;
    const r = ctx.refine?.(p);
    units.push(
      markDirtyOnWrite(pkg, path, {
        part: path,
        key: `${keyPrefix}${i}`,
        location: r?.location ?? ctx.location,
        where: r?.where ?? ctx.where,
        page: ctx.page,
        segments,
        refs,
        note: isInFallback(p) ? FALLBACK_NOTE : undefined,
      }),
    );
  });
  return units;
}

/** Chart part: rich-text titles/labels plus cached category / series-name strings. */
export function collectChart(pkg: OoxmlPackage, path: string, where: string, page?: number): TextUnit[] {
  const units = collectDmlParagraphs(pkg, path, { location: 'chart', where, page });
  const doc = pkg.xml(path);
  if (!doc) return units;
  els(doc, NS.c, 'pt').forEach((pt, i) => {
    const v = firstChildEl(pt, NS.c, 'v');
    const isString = closest(pt, NS.c, 'strCache') || closest(pt, NS.c, 'multiLvlStrCache');
    if (!v || !v.textContent || !isString) return;
    units.push(markDirtyOnWrite(pkg, path, elementUnit(v, { part: path, key: `pt${i}`, location: 'chart', where: `${where}・資料標籤`, page })));
  });
  return units;
}

/** Chart parts referenced from a part (drawing / slide / document). */
export function chartsOf(pkg: OoxmlPackage, part: string): string[] {
  return pkg
    .rels(part)
    .filter((r) => !r.external && /\/chart$/.test(r.type) && pkg.has(r.target))
    .map((r) => r.target);
}

/**
 * Alternative text of pictures and shapes — read by screen readers, search, and DLP text extraction:
 *   DrawingML wp:docPr / p:cNvPr / xdr:cNvPr / pic:cNvPr  @descr @title;  VML  @alt, v:imagedata @o:title.
 */
export function collectAltText(pkg: OoxmlPackage, path: string, where: string, page?: number): TextUnit[] {
  const doc = pkg.xml(path);
  if (!doc) return [];
  const units: TextUnit[] = [];
  let n = 0;
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    const attrs: string[] = [];
    if (el.localName === 'docPr' || el.localName === 'cNvPr') attrs.push('descr', 'title');
    else if (el.namespaceURI === NS.v && el.hasAttribute('alt')) attrs.push('alt');
    else if (el.namespaceURI === NS.v && el.localName === 'imagedata' && el.hasAttributeNS(NS.o, 'title')) attrs.push('o:title');
    for (const a of attrs) {
      const value = a === 'o:title' ? el.getAttributeNS(NS.o, 'title') : el.getAttribute(a);
      if (!value?.trim()) continue;
      units.push(markDirtyOnWrite(pkg, path, attrUnit(el, a, { part: path, key: `alt${n++}`, location: 'other', where: `${where}・替代文字`, page })));
    }
  }
  return units;
}
