import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib';
import type { Candidate } from '../../core/candidates';
import { dataUrl, logoHash, pngEncode, sameLogo, thumbnail, type Pixels } from '../../core/image';
import { pagesLabel } from '../../core/pages';
import type { NormRect, ScanContext } from '../../core/types';
import { apply, placementsOf, type ImagePlacement, type Placement } from './content/interpret';
import { quadsRect, type PdfTextScan } from './content/textScan';
import { lookupDict, nameOf, normRect, streamBytes } from './pdfdoc';

const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

/** Undo PNG predictors (DecodeParms /Predictor >= 10), which pdf-lib's Flate decoder does not apply. */
function unpredict(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const stride = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (stride + 1));
  const out = new Uint8Array(rows * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < rows; y++) {
    const ft = data[y * (stride + 1)]!;
    const line = data.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    out.set(line, y * stride);
    prev = line;
  }
  return out;
}

interface Decoded {
  pixels?: Pixels;
  encoded?: { bytes: Uint8Array; mime: string };
}

/** Best-effort decode of an image XObject into RGBA pixels (or the raw JPEG for the browser to decode). */
export function decodePdfImage(doc: PDFDocument, stream: PDFRawStream): Decoded {
  const d = stream.dict;
  const filters = (() => {
    const f = d.lookup(PDFName.of('Filter'));
    if (f instanceof PDFName) return [f.decodeText()];
    if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : ''));
    return [];
  })();
  if (filters[filters.length - 1] === 'DCTDecode' && filters.length === 1) return { encoded: { bytes: stream.contents, mime: 'image/jpeg' } };
  // generic filters (Flate, LZW, ASCII85, ASCIIHex, RunLength) are undone by pdf-lib; image codecs are not
  if (filters.some((f) => ['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode'].includes(f))) return {};
  const w = num(d.lookup(PDFName.of('Width'))) ?? 0;
  const h = num(d.lookup(PDFName.of('Height'))) ?? 0;
  const bpc = num(d.lookup(PDFName.of('BitsPerComponent'))) ?? 8;
  if (!w || !h || w * h > 4_000_000 || (bpc !== 8 && bpc !== 1)) return {};
  let data = streamBytes(stream);
  if (!data) return {};
  const cs = colorSpace(doc, d.lookup(PDFName.of('ColorSpace')));
  if (!cs) return {};
  const parms = lookupDict(doc, d.get(PDFName.of('DecodeParms')));
  const predictor = num(parms?.lookup(PDFName.of('Predictor'))) ?? 1;
  if (predictor >= 10) data = unpredict(data, cs.n, bpc, num(parms?.lookup(PDFName.of('Columns'))) ?? w);
  const out = new Uint8ClampedArray(w * h * 4);
  const stride = Math.ceil((w * cs.n * bpc) / 8);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const comps: number[] = [];
      for (let k = 0; k < cs.n; k++) {
        if (bpc === 8) comps.push(data[y * stride + x * cs.n + k] ?? 0);
        else {
          const bit = (x * cs.n + k) | 0;
          comps.push((data[y * stride + (bit >> 3)]! >> (7 - (bit & 7))) & 1 ? 255 : 0);
        }
      }
      const [r, g, b] = cs.toRgb(comps);
      const o = (y * w + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  // soft mask → alpha
  const smask = d.lookup(PDFName.of('SMask'));
  if (smask instanceof PDFRawStream) {
    const sw = num(smask.dict.lookup(PDFName.of('Width')));
    const sh = num(smask.dict.lookup(PDFName.of('Height')));
    const sb = streamBytes(smask);
    if (sb && sw === w && sh === h && sb.length >= w * h) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = sb[i]!;
  }
  return { pixels: { w, h, data: out } };
}

function colorSpace(doc: PDFDocument, cs: PDFObject | undefined): { n: number; toRgb: (c: number[]) => [number, number, number] } | undefined {
  const name = nameOf(cs);
  const rgb = { n: 3, toRgb: (c: number[]) => [c[0]!, c[1]!, c[2]!] as [number, number, number] };
  const gray = { n: 1, toRgb: (c: number[]) => [c[0]!, c[0]!, c[0]!] as [number, number, number] };
  const cmyk = {
    n: 4,
    toRgb: (c: number[]) => {
      const k = c[3]! / 255;
      return [255 * (1 - c[0]! / 255) * (1 - k), 255 * (1 - c[1]! / 255) * (1 - k), 255 * (1 - c[2]! / 255) * (1 - k)] as [number, number, number];
    },
  };
  if (name === 'DeviceRGB' || name === 'CalRGB') return rgb;
  if (name === 'DeviceGray' || name === 'CalGray') return gray;
  if (name === 'DeviceCMYK') return cmyk;
  const arr = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (arr instanceof PDFArray) {
    const kind = nameOf(arr.lookup(0));
    if (kind === 'ICCBased') {
      const s = arr.lookup(1);
      const n = s instanceof PDFRawStream ? num(s.dict.lookup(PDFName.of('N'))) : undefined;
      return n === 1 ? gray : n === 4 ? cmyk : rgb;
    }
    if (kind === 'Indexed') {
      const base = colorSpace(doc, arr.lookup(1));
      const lookup = arr.lookup(3);
      const table = lookup instanceof PDFRawStream ? streamBytes(lookup) : lookup && 'asBytes' in lookup ? (lookup as unknown as { asBytes(): Uint8Array }).asBytes() : undefined;
      if (!base || !table) return undefined;
      return { n: 1, toRgb: (c) => base.toRgb(Array.from(table.subarray(c[0]! * base.n, c[0]! * base.n + base.n))) };
    }
    if (kind === 'CalRGB' || kind === 'Lab') return rgb;
    if (kind === 'CalGray') return gray;
  }
  return undefined;
}

export interface ImageInfo {
  thumb?: string;
  hash?: string;
}

/** Thumbnail + perceptual hash for a decoded image. */
export async function describe(dec: Decoded, ctx: ScanContext): Promise<ImageInfo> {
  let pixels = dec.pixels;
  if (!pixels && dec.encoded && ctx.decodeImage) pixels = (await ctx.decodeImage(dec.encoded.bytes, dec.encoded.mime)) ?? undefined;
  if (pixels) return { thumb: dataUrl(pngEncode(thumbnail(pixels)), 'image/png'), hash: logoHash(pixels) };
  if (dec.encoded && dec.encoded.bytes.length < 300_000) return { thumb: dataUrl(dec.encoded.bytes, dec.encoded.mime) };
  return {};
}

function quadRect(doc: PDFDocument, p: ImagePlacement): NormRect {
  const xs = p.quad.map((q) => q[0]);
  const ys = p.quad.map((q) => q[1]);
  return normRect(doc, p.page - 1, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

/** FNV-1a over the image bytes + its dictionary's size keys: the same logo embedded once per page groups as one. */
function contentKey(stream: PDFRawStream): string {
  const b = stream.contents;
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  const w = num(stream.dict.lookup(PDFName.of('Width')));
  const ht = num(stream.dict.lookup(PDFName.of('Height')));
  return `${b.length}:${w}x${ht}:${(h >>> 0).toString(16)}`;
}

/** Every real (page, rect) occurrence of an image placement — a placement inside a shared form appears on many pages. */
function occurrences(doc: PDFDocument, scan: PdfTextScan, p: ImagePlacement, memo: Map<string, Placement[]>): Array<{ page: number; rect: NormRect }> {
  const out: Array<{ page: number; rect: NormRect }> = [];
  for (const pl of placementsOf(scan.result, p.src, memo)) {
    const t = pl.t;
    const rect = t ? quadsRect(doc, pl.page, [p.quad.map(([x, y]) => apply(t, x, y))]) : undefined;
    if (rect) out.push({ page: pl.page, rect });
  }
  return out;
}

/**
 * Logo candidates among placed images:
 *   - the same image on 2+ pages (or in a form drawn on 2+ pages)        → high
 *   - matches a user-supplied logo sample                                  → high
 *   - small image in the header / footer band                              → medium
 *   - small image near the top of page 1 (cover logo)                      → low, not pre-selected
 * Full-page images (scans, backgrounds) and specks are ignored.
 * "The same image" is the same XObject OR identical image bytes (generators often embed the logo once per page).
 */
export async function scanPdfImages(doc: PDFDocument, scan: PdfTextScan, ctx: ScanContext): Promise<Candidate[]> {
  const byRef = new Map<string, ImagePlacement[]>();
  for (const p of scan.result.images) {
    const key = p.ref ? `img${p.ref.objectNumber}_${p.ref.generationNumber}` : `inline:${p.src.key}:${p.instr}`;
    byRef.set(key, [...(byRef.get(key) ?? []), p]);
  }
  // merge XObjects with identical bytes (first in document order names the group, so ids stay stable)
  const groups = new Map<string, ImagePlacement[]>();
  const byContent = new Map<string, string>();
  for (const [key, placements] of byRef) {
    const first = placements[0]!;
    const rect = quadRect(doc, first);
    const stream = first.ref ? doc.context.lookup(first.ref) : undefined;
    const area = rect.w * rect.h;
    const ck = stream instanceof PDFRawStream && area <= 0.5 && area >= 0.0004 ? contentKey(stream) : undefined;
    const target = ck ? byContent.get(ck) : undefined;
    if (target) groups.get(target)!.push(...placements);
    else {
      groups.set(key, [...placements]);
      if (ck) byContent.set(ck, key);
    }
  }
  const memo = new Map<string, Placement[]>();
  const out: Candidate[] = [];
  for (const [key, placements] of groups) {
    const first = placements[0]!;
    const occ = placements.flatMap((p) => occurrences(doc, scan, p, memo));
    const pages = new Set<number>(occ.map((o) => o.page));
    for (const p of placements) for (const pg of placementsOf(scan.result, p.src, memo).map((x) => x.page)) pages.add(pg);
    const rect = quadRect(doc, first);
    const area = rect.w * rect.h;
    if (area > 0.5 || area < 0.0004) continue;
    const band = rect.y + rect.h < 0.16 ? 'header' : rect.y > 0.86 ? 'footer' : null;
    const cover = !band && first.page === 1 && rect.y < 0.35 && area < 0.12;

    const stream = first.ref ? doc.context.lookup(first.ref) : undefined;
    const info = stream instanceof PDFRawStream ? await describe(decodePdfImage(doc, stream), ctx) : {};
    const sample = !!info.hash && !!ctx.logoHashes?.some((h) => sameLogo(h, info.hash!));
    const repeated = pages.size >= 2;
    if (!repeated && !sample && !band && !cover) continue;

    const confidence = repeated || sample ? 'high' : band ? 'medium' : 'low';
    const firstPage = Math.min(...pages);
    const where = `${pages.size > 1 ? pagesLabel(pages) : `第 ${firstPage} 頁`}・${band === 'header' ? '頁首' : band === 'footer' ? '頁尾' : cover ? '封面' : '頁面'}圖片`;
    const reasons = [sample ? '與你上傳的 Logo 樣本相符' : '', repeated ? `在 ${pages.size} 頁重複出現` : '', band ? `位於${band === 'header' ? '頁首' : '頁尾'}` : '', cover ? '位於封面頂部，可能是 Logo，請確認' : ''].filter(Boolean);
    const byPage = new Map<number, NormRect[]>();
    for (const o of occ) byPage.set(o.page, [...(byPage.get(o.page) ?? []), o.rect]);
    const highlights = [...byPage].sort((a, b) => a[0] - b[0]).map(([page, rects]) => ({ page, rects }));
    const refs = [...new Map(placements.filter((p) => p.ref).map((p) => [p.ref!.toString(), p.ref!])).values()];
    out.push({
      finding: {
        id: `${key}#logo`,
        kind: 'image',
        location: band ?? 'body',
        matchText: sample ? 'Logo（符合樣本）' : '可能是 Logo 的圖片',
        context: { before: '', match: sample ? 'Logo（符合樣本）' : '可能是 Logo 的圖片', after: '' },
        where,
        page: firstPage,
        rects: highlights.find((h) => h.page === firstPage)?.rects ?? [rect],
        highlights,
        thumbnail: info.thumb,
        confidence,
        removable: true,
        defaultSelected: confidence !== 'low',
        note: `${reasons.join('、')}；${pages.size > 1 ? `將從全部 ${pages.size} 頁（${pagesLabel(pages, 12)}）移除` : '圖片將被移除'}`,
      },
      remove: () => {
        for (const p of placements) {
          const set = scan.deletes.get(p.src.key) ?? new Set<number>();
          set.add(p.instr);
          scan.deletes.set(p.src.key, set);
        }
        scan.dropXObjects.push(...refs);
      },
    });
  }
  return out;
}

/** Image XObjects every interpreted placement of which is being deleted (by logo findings or regions). */
export function fullyDeletedImages(scan: PdfTextScan): PDFRef[] {
  const status = new Map<string, { ref: PDFRef; all: boolean }>();
  for (const p of scan.result.images) {
    if (!p.ref) continue;
    const k = p.ref.toString();
    const deleted = !!scan.deletes.get(p.src.key)?.has(p.instr);
    const cur = status.get(k);
    status.set(k, { ref: p.ref, all: (cur ? cur.all : true) && deleted });
  }
  return [...status.values()].filter((s) => s.all).map((s) => s.ref);
}

/** Remove resource entries that point at removed images so garbage collection can drop the image data itself. */
export function dropImageResources(doc: PDFDocument, refs: PDFRef[]): void {
  if (!refs.length) return;
  const targets = new Set(refs.map((r) => r.toString()));
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const owner = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    const res = owner && lookupDict(doc, owner.get(PDFName.of('Resources')));
    const xo = res && lookupDict(doc, res.get(PDFName.of('XObject')));
    if (!xo) continue;
    for (const [k, v] of xo.entries()) if (v instanceof PDFRef && targets.has(v.toString())) xo.delete(k);
  }
}
