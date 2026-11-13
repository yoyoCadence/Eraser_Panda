import type { Candidate } from '../../core/candidates';
import { dataUrl, logoHash, mimeOf, pngDecode, pngEncode, sameLogo, thumbnail, type Pixels } from '../../core/image';
import type { LocationKind, ScanContext } from '../../core/types';
import { OoxmlPackage } from './package';
import { partNumber } from './units';
import { NS, closest, els, removeEl } from './xml';
import { HF_RE, tokenizeHeaderFooter } from './xlsx';

type Format = 'docx' | 'xlsx' | 'pptx';

interface Use {
  part: string;
  rId: string;
  /** element to delete to remove this use */
  container: Element;
  location: LocationKind;
  where: string;
  page?: number;
  watermark?: boolean;
}

/** Where a part sits in the document, for logo scoring. */
function partRole(pkg: OoxmlPackage, format: Format, part: string, slideNo: Map<string, number>): { location: LocationKind; where: string; page?: number; strong: boolean } | null {
  const ct = pkg.contentType(part) ?? '';
  if (format === 'docx') {
    if (ct.endsWith('wordprocessingml.header+xml')) return { location: 'header', where: `頁首 ${partNumber(part) ?? ''}`.trim(), strong: true };
    if (ct.endsWith('wordprocessingml.footer+xml')) return { location: 'footer', where: `頁尾 ${partNumber(part) ?? ''}`.trim(), strong: true };
    if (/document\.main\+xml|macroEnabled\.main\+xml|template\.main\+xml/.test(ct)) return { location: 'body', where: '內文', strong: false };
    return null;
  }
  if (format === 'pptx') {
    if (ct.endsWith('slideMaster+xml')) return { location: 'master', where: `投影片母片 ${partNumber(part) ?? ''}`.trim(), strong: true };
    if (ct.endsWith('slideLayout+xml')) return { location: 'master', where: `版面配置 ${partNumber(part) ?? ''}`.trim(), strong: true };
    if (ct.endsWith('presentationml.slide+xml')) {
      const n = slideNo.get(part);
      return { location: 'body', where: n ? `第 ${n} 張投影片` : '投影片', page: n, strong: false };
    }
    return null;
  }
  if (ct.endsWith('drawing+xml') && part.includes('/drawings/')) return { location: 'body', where: '工作表圖片', strong: false };
  return null;
}

function slideNumbers(pkg: OoxmlPackage): Map<string, number> {
  const m = new Map<string, number>();
  const pres = pkg.rels('').find((r) => /\/officeDocument$/.test(r.type))?.target;
  const doc = pres ? pkg.xml(pres) : undefined;
  if (doc && pres) els(doc, NS.p, 'sldId').forEach((el, i) => {
    const t = pkg.relTarget(pres, el.getAttributeNS(NS.r, 'id') ?? '');
    if (t) m.set(t, i + 1);
  });
  return m;
}

/** The element whose removal removes this picture (and its compatibility fallback, if any). */
function containerOf(el: Element, format: Format): Element | null {
  let c: Element | null;
  if (format === 'docx') c = closest(el, NS.w, 'drawing') ?? closest(el, NS.w, 'pict');
  else if (format === 'pptx') {
    if (closest(el, NS.p, 'bg')) return null; // slide backgrounds are not logos
    c = closest(el, NS.p, 'pic') ?? closest(el, NS.p, 'sp');
  } else c = closest(el, NS.xdr, 'twoCellAnchor') ?? closest(el, NS.xdr, 'oneCellAnchor') ?? closest(el, NS.xdr, 'absoluteAnchor');
  if (!c) return null;
  const alt = closest(c, NS.mc, 'AlternateContent');
  if (alt) c = alt;
  if (format === 'docx') {
    const run = closest(c, NS.w, 'r');
    if (run) c = run;
  }
  return c;
}

async function describeMedia(pkg: OoxmlPackage, path: string, ctx: ScanContext): Promise<{ thumb?: string; hash?: string }> {
  const bytes = pkg.bytes(path);
  const mime = mimeOf(path);
  if (!bytes || !mime) return {};
  let pixels: Pixels | null = null;
  if (mime === 'image/png') pixels = pngDecode(bytes);
  else if (ctx.decodeImage && /jpeg|gif|bmp|webp/.test(mime)) pixels = await ctx.decodeImage(bytes, mime);
  if (pixels) return { thumb: dataUrl(pngEncode(thumbnail(pixels)), 'image/png'), hash: logoHash(pixels) };
  if (/jpeg|gif|webp|bmp/.test(mime) && bytes.length < 300_000) return { thumb: dataUrl(bytes, mime) };
  return {};
}

/**
 * Logo candidates in an OOXML package, grouped per media file (one finding removes every use of that image):
 *   Word: header/footer pictures (+ picture watermarks); PowerPoint: master/layout pictures and pictures repeated on
 *   2+ slides; Excel: header/footer pictures and pictures on 2+ sheets. Any picture matching a logo sample.
 */
export async function scanOoxmlImages(pkg: OoxmlPackage, format: Format, ctx: ScanContext, idPrefix = ''): Promise<Candidate[]> {
  const slideNo = format === 'pptx' ? slideNumbers(pkg) : new Map<string, number>();
  const byMedia = new Map<string, Use[]>();
  for (const part of pkg.paths) {
    const role = partRole(pkg, format, part, slideNo);
    if (!role) continue;
    const doc = pkg.xml(part);
    if (!doc) continue;
    const refs: Array<[Element, string]> = [];
    for (const blip of els(doc, NS.a, 'blip')) refs.push([blip, blip.getAttributeNS(NS.r, 'embed') ?? '']);
    for (const im of els(doc, NS.v, 'imagedata')) refs.push([im, im.getAttributeNS(NS.r, 'id') ?? im.getAttributeNS(NS.o, 'relid') ?? '']);
    for (const [el, rId] of refs) {
      if (!rId) continue;
      const media = pkg.relTarget(part, rId);
      const container = containerOf(el, format);
      if (!media || !container || !pkg.has(media)) continue;
      const shape = closest(el, NS.v, 'shape');
      const watermark = /WordPictureWatermark|PowerPlusWaterMark/i.test(shape?.getAttribute('id') ?? '');
      const use: Use = { part, rId, container, location: watermark ? 'watermark' : role.location, where: role.where, page: role.page, watermark };
      byMedia.set(media, [...(byMedia.get(media) ?? []), use]);
    }
  }

  // Group by CONTENT, not path: Office (and openpyxl) store the same logo as image1.png, image2.png, … per sheet/part.
  const byContent = new Map<string, { media: string[]; uses: Use[] }>();
  for (const [media, uses] of byMedia) {
    const key = contentKey(pkg.bytes(media)!);
    const g = byContent.get(key) ?? { media: [], uses: [] };
    g.media.push(media);
    g.uses.push(...uses);
    byContent.set(key, g);
  }

  const out: Candidate[] = [];
  for (const { media: mediaList, uses } of byContent.values()) {
    const media = mediaList.sort()[0]!;
    const strong = uses.some((u) => partRole(pkg, format, u.part, slideNo)?.strong);
    const watermark = uses.some((u) => u.watermark);
    const places = new Set(uses.map((u) => u.part));
    const repeated = places.size >= 2 && format !== 'docx';
    const info = await describeMedia(pkg, media, ctx);
    const sample = !!info.hash && !!ctx.logoHashes?.some((h) => sameLogo(h, info.hash!));
    if (!strong && !repeated && !sample && !watermark) continue;
    const primary = uses.find((u) => u.watermark) ?? uses.find((u) => partRole(pkg, format, u.part, slideNo)?.strong) ?? uses[0]!;
    const reasons = [
      sample ? '與你上傳的 Logo 樣本相符' : '',
      watermark ? '圖片浮水印' : '',
      strong && !watermark ? (format === 'pptx' ? '位於母片 / 版面配置（每張投影片都會出現）' : '位於頁首 / 頁尾') : '',
      repeated ? `在 ${places.size} 處重複使用` : '',
    ].filter(Boolean);
    out.push({
      finding: {
        id: `${idPrefix}${media}#logo`,
        kind: watermark ? 'watermark' : 'image',
        location: primary.location,
        matchText: sample ? 'Logo（符合樣本）' : watermark ? '圖片浮水印' : '可能是 Logo 的圖片',
        context: { before: '', match: sample ? 'Logo（符合樣本）' : watermark ? '圖片浮水印' : '可能是 Logo 的圖片', after: ` ${media.slice(media.lastIndexOf('/') + 1)}` },
        where: `${primary.where}${uses.length > 1 ? `（共 ${uses.length} 處）` : ''}`,
        page: primary.page,
        part: media,
        thumbnail: info.thumb,
        confidence: sample || watermark || strong || repeated ? 'high' : 'medium',
        removable: true,
        defaultSelected: true,
        note: `${reasons.join('、')}；${uses.length > 1 ? `將移除全部 ${uses.length} 處` : '圖片將被移除'}`,
      },
      remove: () => {
        for (const u of uses) {
          removeEl(u.container);
          pkg.markDirty(u.part);
        }
        for (const part of new Set(uses.map((u) => u.part))) pruneRels(pkg, part);
      },
    });
  }

  if (format === 'xlsx') out.push(...headerFooterImages(pkg, ctx, idPrefix));
  return out;
}

/** Cheap content identity for media files (length + FNV-1a over the bytes). */
function contentKey(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${b.length}:${(h >>> 0).toString(36)}`;
}

/** Drop relationships of `part` whose id no longer occurs in its XML, then media no longer referenced anywhere. */
export function pruneRels(pkg: OoxmlPackage, part: string): void {
  const doc = pkg.xml(part);
  if (!doc) return;
  const xml = new XMLSerializer().serializeToString(doc);
  for (const r of pkg.rels(part)) {
    if (r.external || !/\/image$/.test(r.type)) continue;
    if (xml.includes(`"${r.id}"`)) continue;
    pkg.removeRel(part, r.id);
    if (!pkg.isReferenced(r.target)) pkg.removePart(r.target);
  }
}

/** Excel header/footer pictures: &G codes + the legacyDrawingHF VML part. One finding per sheet. */
function headerFooterImages(pkg: OoxmlPackage, _ctx: ScanContext, idPrefix: string): Candidate[] {
  const out: Candidate[] = [];
  for (const sheet of pkg.paths.filter((p) => (pkg.contentType(p) ?? '').endsWith('spreadsheetml.worksheet+xml'))) {
    // worksheets are never parsed as a whole (they can be huge) — locate the two elements by text
    const xml = pkg.text(sheet) ?? '';
    const ld = /<legacyDrawingHF\b[^>]*?(?:\/>|>[\s\S]*?<\/legacyDrawingHF>)/.exec(xml);
    if (!ld) continue;
    const rId = /\br:id="([^"]+)"/.exec(ld[0])?.[1] ?? /\bid="([^"]+)"/.exec(ld[0])?.[1] ?? '';
    const vml = pkg.relTarget(sheet, rId);
    const media = vml ? pkg.rels(vml).filter((r) => /\/image$/.test(r.type)).map((r) => r.target) : [];
    const hfMatch = HF_RE.exec(xml);
    out.push({
      finding: {
        id: `${idPrefix}${sheet}#hfimage`,
        kind: 'image',
        location: 'header',
        matchText: '頁首 / 頁尾圖片',
        context: { before: '', match: '頁首 / 頁尾圖片', after: media.length ? ` ${media.map((m) => m.slice(m.lastIndexOf('/') + 1)).join('、')}` : '' },
        where: `${sheet.slice(sheet.lastIndexOf('/') + 1)}・頁首頁尾`,
        part: sheet,
        confidence: 'high',
        removable: true,
        defaultSelected: true,
        note: 'Excel 頁首 / 頁尾中的圖片幾乎都是公司 Logo；將移除 &G 圖片代碼與對應圖片',
      },
      remove: () => {
        if (hfMatch) {
          const frag = pkg.fragment(sheet, hfMatch.index, hfMatch.index + hfMatch[0].length);
          for (const el of Array.from(frag.el.children)) {
            el.textContent = tokenizeHeaderFooter(el.textContent ?? '').map((t) => (t.code ? (t.raw === '&G' ? '' : t.raw) : t.text.replace(/&/g, '&&'))).join('');
          }
          frag.touch();
        }
        pkg.removeText(sheet, ld.index, ld.index + ld[0].length);
        if (vml) {
          pkg.removeRel(sheet, rId);
          if (!pkg.isReferenced(vml)) pkg.removePart(vml);
          for (const m of media) if (!pkg.isReferenced(m)) pkg.removePart(m);
        }
      },
    });
  }
  return out;
}

export { OoxmlPackage };
