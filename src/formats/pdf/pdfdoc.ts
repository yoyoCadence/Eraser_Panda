import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib';
import { UserFacingError } from '../../core/types';

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    throw new UserFacingError(`PDF 已損毀或格式無法解析（${(e as Error).message}）。可嘗試用瀏覽器開啟後「列印 → 另存為 PDF」再處理。`);
  }
  if (doc.isEncrypted) {
    throw new UserFacingError('此 PDF 已加密（開啟密碼或權限密碼）。請先在 Acrobat 移除安全性設定，或用瀏覽器開啟後「列印 → 另存為 PDF」，再交給本工具處理。');
  }
  return doc;
}

/** Text of a PDF string object (PDFDocEncoding or UTF-16BE), or undefined for other types. */
export function pdfText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return undefined;
}

/** Encode text as a PDF string: plain literal when it is printable ASCII, otherwise UTF-16BE hex. */
export function toPdfString(text: string): PDFString | PDFHexString {
  return /^[\x20-\x7e]*$/.test(text) ? PDFString.of(text.replace(/[\\()]/g, (c) => `\\${c}`)) : PDFHexString.fromText(text);
}

export function nameOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

export function lookupDict(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return o instanceof PDFDict ? o : undefined;
}

export function lookupArray(doc: PDFDocument, obj: PDFObject | undefined): PDFArray | undefined {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return o instanceof PDFArray ? o : undefined;
}

/** Decoded bytes of a stream (Flate/LZW/ASCII85/ASCIIHex/RunLength), or undefined if the filter is unsupported. */
export function streamBytes(stream: PDFObject | undefined): Uint8Array | undefined {
  if (!(stream instanceof PDFRawStream)) {
    if (stream instanceof PDFStream) return stream.getContents();
    return undefined;
  }
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  if (!filter) return stream.contents;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

export function infoDict(doc: PDFDocument): PDFDict | undefined {
  return lookupDict(doc, doc.context.trailerInfo.Info);
}

/**
 * Delete every indirect object that is not reachable from the trailer (Root / Info).
 * pdf-lib parses ALL objects in the file — including stale ones from incremental updates and old object streams —
 * and would otherwise write them back out, leaving removed labels recoverable in the "clean" file.
 * Returns the number of objects deleted.
 */
export function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info } = ctx.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  let deleted = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      ctx.delete(ref);
      deleted++;
    }
  }
  return deleted;
}

export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  collectGarbage(doc);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** Page size (CropBox, falling back to MediaBox) for normalising rectangles. */
export function pageBox(doc: PDFDocument, pageIndex: number): { x: number; y: number; w: number; h: number } {
  const page = doc.getPage(pageIndex);
  const b = page.getCropBox?.() ?? page.getMediaBox();
  return { x: b.x, y: b.y, w: b.width || 612, h: b.height || 792 };
}

/**
 * Convert a rectangle in PDF user space ([x1, y1, x2, y2], origin bottom-left) into a rectangle normalised to the
 * page AS DISPLAYED (0..1, origin top-left), honouring the page's /Rotate.
 */
export function normRect(doc: PDFDocument, pageIndex: number, r: [number, number, number, number]): { x: number; y: number; w: number; h: number } {
  const b = pageBox(doc, pageIndex);
  const rot = (((doc.getPage(pageIndex).getRotation().angle ?? 0) % 360) + 360) % 360;
  const map = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 90:
        return [(y - b.y) / b.h, (x - b.x) / b.w];
      case 180:
        return [(b.x + b.w - x) / b.w, (y - b.y) / b.h];
      case 270:
        return [(b.y + b.h - y) / b.h, (b.x + b.w - x) / b.w];
      default:
        return [(x - b.x) / b.w, (b.y + b.h - y) / b.h];
    }
  };
  const [ax, ay] = map(r[0], r[1]);
  const [bx, by] = map(r[2], r[3]);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
