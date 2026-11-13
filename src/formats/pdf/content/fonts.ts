import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFDocument, type PDFObject } from 'pdf-lib';
import { GLYPH_TO_UNICODE } from '../data/glyphNames';
import { STD_WIDTHS } from '../data/stdWidths';
import { lookupArray, lookupDict, nameOf, streamBytes } from '../pdfdoc';
import { latin1 } from './lexer';

export interface Glyph {
  /** original code bytes */
  bytes: Uint8Array;
  /** decoded text ('�' when unknown) */
  text: string;
  /** horizontal displacement in text space per unit font size (i.e. width / 1000) */
  w0: number;
  /** single-byte code 32 — word spacing (Tw) applies */
  space: boolean;
}

export interface FontInfo {
  name: string;
  decode(bytes: Uint8Array): Glyph[];
  vertical: boolean;
  /** per 1 unit font size */
  ascent: number;
  descent: number;
}

const REPLACEMENT = '�';
const cp1252 = new TextDecoder('windows-1252');
let macRoman: TextDecoder | undefined;
try {
  macRoman = new TextDecoder('macintosh');
} catch {
  macRoman = undefined;
}

interface CMapData {
  ranges: Array<{ len: number; lo: Uint8Array; hi: Uint8Array }>;
  uni: Map<number, string>;
  cid: Map<number, number>;
}

/** Parse a CMap program (ToUnicode or an embedded encoding CMap). */
export function parseCMap(text: string): CMapData {
  const data: CMapData = { ranges: [], uni: new Map(), cid: new Map() };
  const hexes = (s: string) => [...s.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((m) => hexBytes(m[1]!));
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const h = hexes(m[1]!);
    for (let i = 0; i + 1 < h.length; i += 2) data.ranges.push({ len: h[i]!.length, lo: h[i]!, hi: h[i + 1]! });
  }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const h = hexes(m[1]!);
    for (let i = 0; i + 1 < h.length; i += 2) data.uni.set(toInt(h[i]!), utf16be(h[i + 1]!));
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // entries: <lo> <hi> <dst>   or   <lo> <hi> [<d1> <d2> …]
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g)) {
      const lo = toInt(hexBytes(e[1]!));
      const hi = toInt(hexBytes(e[2]!));
      if (hi - lo > 0xffff) continue;
      if (e[3]!.startsWith('[')) {
        hexes(e[3]!).forEach((d, k) => lo + k <= hi && data.uni.set(lo + k, utf16be(d)));
      } else {
        const base = hexBytes(e[3]!.slice(1, -1));
        for (let c = lo; c <= hi; c++) {
          const d = base.slice();
          // increment the last byte(s) by the offset
          let carry = c - lo;
          for (let k = d.length - 1; k >= 0 && carry > 0; k--) {
            const v = d[k]! + carry;
            d[k] = v & 0xff;
            carry = v >> 8;
          }
          data.uni.set(c, utf16be(d));
        }
      }
    }
  }
  for (const m of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(\d+)/g)) {
      const lo = toInt(hexBytes(e[1]!));
      const hi = toInt(hexBytes(e[2]!));
      if (hi - lo > 0xffff) continue;
      for (let c = lo; c <= hi; c++) data.cid.set(c, Number(e[3]) + c - lo);
    }
  }
  for (const m of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f\s]*)>\s*(\d+)/g)) data.cid.set(toInt(hexBytes(e[1]!)), Number(e[2]));
  }
  return data;
}

function hexBytes(h: string): Uint8Array {
  const s = h.replace(/\s+/g, '');
  const out = new Uint8Array(Math.ceil(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2).padEnd(2, '0'), 16);
  return out;
}

function toInt(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function utf16be(b: Uint8Array): string {
  if (b.length === 1) return String.fromCharCode(b[0]!);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return s;
}

/** Predefined CJK CMaps whose codes are a legacy multi-byte encoding we can decode with TextDecoder. */
const LEGACY_CMAPS: Array<[RegExp, string, Array<[number, number]>]> = [
  // [name pattern, TextDecoder label, single-byte ranges]
  [/^(ETen|ETenms|HKscs|HKdla|HKdlb|HKgccs|HKm314|HKm471|B5pc|B5)-/i, 'big5', [[0x00, 0x80]]],
  [/^(GBK|GBK2K|GBKp|GBpc|GB|GBT)-/i, 'gbk', [[0x00, 0x80]]],
  [/^(90ms|90msp|83pv|90pv|Add|Ext)-RKSJ/i, 'shift_jis', [[0x00, 0x80], [0xa0, 0xdf]]],
  [/^(KSCms|KSCpc|KSC)-/i, 'euc-kr', [[0x00, 0x80]]],
  [/^EUC-/i, 'euc-jp', [[0x00, 0x80]]],
];

const STD_FAMILY: Array<[RegExp, string]> = [
  [/^(helvetica|arial|arialmt|liberationsans)/i, 'Helvetica'],
  [/^(times|timesnewroman|liberationserif)/i, 'Times'],
];

function standardWidths(baseFont: string): ((code: number) => number) | undefined {
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  if (/courier/i.test(name)) return () => 600;
  const fam = STD_FAMILY.find(([re]) => re.test(name.replace(/[\s-]/g, '')))?.[1];
  if (!fam) return undefined;
  const bold = /bold|black|heavy/i.test(name);
  const italic = /italic|oblique/i.test(name);
  const key = fam === 'Helvetica' ? (bold ? 'Helvetica-Bold' : 'Helvetica') : bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  const table = STD_WIDTHS[key]!;
  return (code) => table[code - 32] ?? 0;
}

function num(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

const cache = new WeakMap<PDFDict, FontInfo>();

export function loadFont(doc: PDFDocument, ref: PDFObject | undefined): FontInfo {
  const dict = lookupDict(doc, ref);
  if (!dict) return fallbackFont();
  const hit = cache.get(dict);
  if (hit) return hit;
  let font: FontInfo;
  try {
    font = nameOf(dict.lookup(PDFName.of('Subtype'))) === 'Type0' ? type0Font(doc, dict) : simpleFont(doc, dict);
  } catch {
    font = fallbackFont();
  }
  cache.set(dict, font);
  return font;
}

function fallbackFont(): FontInfo {
  return {
    name: '?',
    vertical: false,
    ascent: 0.8,
    descent: -0.2,
    decode: (bytes) => Array.from(bytes, (b) => ({ bytes: Uint8Array.of(b), text: cp1252.decode(Uint8Array.of(b)), w0: 0.5, space: b === 32 })),
  };
}

function toUnicodeOf(dict: PDFDict): CMapData | undefined {
  const tu = dict.lookup(PDFName.of('ToUnicode'));
  if (!(tu instanceof PDFRawStream)) return undefined;
  const bytes = streamBytes(tu);
  return bytes ? parseCMap(latin1(bytes)) : undefined;
}

function metrics(doc: PDFDocument, dict: PDFDict): { ascent: number; descent: number; missing: number | undefined } {
  const fd = lookupDict(doc, dict.get(PDFName.of('FontDescriptor')));
  const a = num(fd?.lookup(PDFName.of('Ascent')));
  const d = num(fd?.lookup(PDFName.of('Descent')));
  return { ascent: a ? a / 1000 : 0.8, descent: d ? d / 1000 : -0.2, missing: num(fd?.lookup(PDFName.of('MissingWidth'))) };
}

function simpleFont(doc: PDFDocument, dict: PDFDict): FontInfo {
  const baseFont = nameOf(dict.lookup(PDFName.of('BaseFont'))) ?? '';
  const subtype = nameOf(dict.lookup(PDFName.of('Subtype')));
  const toUni = toUnicodeOf(dict);

  // ---- encoding table ----
  const table: string[] = new Array(256);
  const enc = dict.lookup(PDFName.of('Encoding'));
  let baseName = nameOf(enc);
  let diffs: PDFArray | undefined;
  if (enc instanceof PDFDict) {
    baseName = nameOf(enc.lookup(PDFName.of('BaseEncoding')));
    diffs = lookupArray(doc, enc.get(PDFName.of('Differences')));
  }
  for (let c = 0; c < 256; c++) {
    const b = Uint8Array.of(c);
    table[c] = baseName === 'MacRomanEncoding' && macRoman ? macRoman.decode(b) : cp1252.decode(b);
  }
  if (baseName === 'StandardEncoding' || (!baseName && subtype === 'Type1')) {
    table[0x27] = '’';
    table[0x60] = '‘';
  }
  if (diffs) {
    let code = 0;
    for (let i = 0; i < diffs.size(); i++) {
      const o = diffs.lookup(i);
      if (o instanceof PDFNumber) code = o.asNumber();
      else if (o instanceof PDFName) {
        const u = glyphToUnicode(o.decodeText());
        if (u !== undefined && code < 256) table[code] = u;
        code++;
      }
    }
  }

  // ---- widths ----
  const first = num(dict.lookup(PDFName.of('FirstChar'))) ?? 0;
  const widths = lookupArray(doc, dict.get(PDFName.of('Widths')));
  const m = metrics(doc, dict);
  const std = widths ? undefined : standardWidths(baseFont);
  let scale = 0.001;
  if (subtype === 'Type3') {
    const fm = lookupArray(doc, dict.get(PDFName.of('FontMatrix')));
    scale = num(fm?.lookup(0)) ?? 0.001;
  }
  const widthOf = (code: number): number => {
    if (widths) {
      const w = num(widths.lookup(code - first));
      if (w !== undefined) return w * scale;
      return (m.missing ?? 0) * scale;
    }
    if (std) return std(code) / 1000;
    return (m.missing ?? 500) / 1000;
  };

  return {
    name: baseFont,
    vertical: false,
    ascent: m.ascent,
    descent: m.descent,
    decode: (bytes) =>
      Array.from(bytes, (c) => ({
        bytes: Uint8Array.of(c),
        text: toUni?.uni.get(c) ?? table[c] ?? REPLACEMENT,
        w0: widthOf(c),
        space: c === 32,
      })),
  };
}

export function glyphToUnicode(name: string): string | undefined {
  const base = name.split('.')[0]!.split('_')[0]!;
  const known = GLYPH_TO_UNICODE.get(base);
  if (known !== undefined) return known;
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(base);
  if (m) {
    const hex = m[1]!;
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  if (base.length === 1) return base;
  return undefined;
}

function type0Font(doc: PDFDocument, dict: PDFDict): FontInfo {
  const baseFont = nameOf(dict.lookup(PDFName.of('BaseFont'))) ?? '';
  const toUni = toUnicodeOf(dict);
  const encObj = dict.lookup(PDFName.of('Encoding'));
  const encName = nameOf(encObj) ?? '';
  let encCMap: CMapData | undefined;
  if (encObj instanceof PDFRawStream) {
    const b = streamBytes(encObj);
    if (b) encCMap = parseCMap(latin1(b));
  }
  const vertical = /-V$/.test(encName);
  const isIdentity = /^Identity-[HV]$/.test(encName);
  const isUcs2 = /-UCS2-[HV]$/.test(encName);
  const isUtf16 = /-UTF16-[HV]$/.test(encName);
  const legacy = LEGACY_CMAPS.find(([re]) => re.test(encName));
  let legacyDecoder: TextDecoder | undefined;
  if (legacy) {
    try {
      legacyDecoder = new TextDecoder(legacy[1]);
    } catch {
      legacyDecoder = undefined;
    }
  }

  // ---- code lengths ----
  const ranges = encCMap?.ranges.length ? encCMap.ranges : toUni?.ranges.length && !isIdentity && !isUcs2 && !isUtf16 && !legacy ? toUni.ranges : undefined;
  const codeLen = (bytes: Uint8Array, i: number): number => {
    if (legacy) {
      const b = bytes[i]!;
      return legacy[2].some(([lo, hi]) => b >= lo && b <= hi) ? 1 : 2;
    }
    if (isUtf16) {
      const hi = bytes[i]!;
      return hi >= 0xd8 && hi <= 0xdb ? 4 : 2;
    }
    if (ranges) {
      for (let len = 1; len <= 4; len++) {
        if (i + len > bytes.length) break;
        if (ranges.some((r) => r.len === len && inRange(bytes, i, r))) return len;
      }
    }
    return 2;
  };

  // ---- widths ----
  const desc = lookupDict(doc, lookupArray(doc, dict.get(PDFName.of('DescendantFonts')))?.get(0));
  const dw = num(desc?.lookup(PDFName.of('DW'))) ?? 1000;
  const wmap = new Map<number, number>();
  const W = desc ? lookupArray(doc, desc.get(PDFName.of('W'))) : undefined;
  if (W) {
    let i = 0;
    while (i < W.size()) {
      const c0 = num(W.lookup(i));
      const next = W.lookup(i + 1);
      if (c0 === undefined) break;
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k++) {
          const w = num(next.lookup(k));
          if (w !== undefined) wmap.set(c0 + k, w);
        }
        i += 2;
      } else {
        const c1 = num(next);
        const w = num(W.lookup(i + 2));
        if (c1 !== undefined && w !== undefined && c1 - c0 < 0x10000) for (let c = c0; c <= c1; c++) wmap.set(c, w);
        i += 3;
      }
    }
  }
  const m = desc ? metrics(doc, desc) : { ascent: 0.88, descent: -0.12, missing: undefined };

  return {
    name: baseFont,
    vertical,
    ascent: m.ascent,
    descent: m.descent,
    decode: (bytes) => {
      const out: Glyph[] = [];
      let i = 0;
      while (i < bytes.length) {
        const len = Math.min(codeLen(bytes, i), bytes.length - i);
        const cb = bytes.subarray(i, i + len);
        const code = toInt(cb);
        let text = toUni?.uni.get(code);
        if (text === undefined) {
          if (isUcs2 || isUtf16) text = utf16be(cb);
          else if (legacyDecoder) text = legacyDecoder.decode(cb);
          else text = REPLACEMENT;
        }
        const cid = isIdentity ? code : encCMap?.cid.get(code);
        let w = cid !== undefined ? wmap.get(cid) : undefined;
        if (w === undefined) w = cid !== undefined ? dw : /^[\x20-\x7e]$/.test(text) ? Math.min(dw, 500) : dw;
        out.push({ bytes: cb.slice(), text, w0: w / 1000, space: len === 1 && code === 32 });
        i += len;
      }
      return out;
    },
  };
}

function inRange(bytes: Uint8Array, i: number, r: { len: number; lo: Uint8Array; hi: Uint8Array }): boolean {
  for (let k = 0; k < r.len; k++) {
    const b = bytes[i + k]!;
    if (b < r.lo[k]! || b > r.hi[k]!) return false;
  }
  return true;
}
