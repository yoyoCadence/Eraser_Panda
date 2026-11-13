import { inflateSync, strFromU8, unzipSync, unzlibSync } from 'fflate';
import { findHits, type CompiledRules } from '../core/matcher';
import type { FormatId } from '../core/types';

export interface RawHit {
  /** where in the file (stream #n, zip part …) */
  where: string;
  text: string;
  context: string;
}

const latin1 = new TextDecoder('latin1');

/**
 * Last line of defence: look at the raw bytes of an output file — every PDF stream decompressed, every zip part
 * unpacked — for rule hits, independent of how our structured scanners understand the file. This catches data the
 * structured scan cannot see: orphaned objects, stale incremental-update revisions, unknown parts.
 *
 * It only sees text stored in a readable encoding (ASCII / Latin-1 / UTF-8 / UTF-16). Text drawn with
 * subset-font glyph ids is invisible here — the structured re-scan covers that.
 */
export function rawScan(format: FormatId, bytes: Uint8Array, compiled: CompiledRules): RawHit[] {
  const chunks = format === 'pdf' ? pdfChunks(bytes) : format === 'text' ? [{ where: '檔案', text: new TextDecoder().decode(bytes) }] : zipChunks(bytes);
  const out: RawHit[] = [];
  for (const c of chunks) {
    for (const h of findHits(c.text, compiled)) {
      out.push({ where: c.where, text: h.text, context: c.text.slice(Math.max(0, h.start - 30), h.end + 30).replace(/\s+/g, ' ') });
    }
  }
  return out;
}

function zipChunks(bytes: Uint8Array): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const walk = (data: Uint8Array, prefix: string, depth: number) => {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data);
    } catch {
      return;
    }
    for (const [name, content] of Object.entries(entries)) {
      if (/\.(xml|rels|vml|txt)$/i.test(name)) out.push({ where: prefix + name, text: xmlText(strFromU8(content)) });
      else if (/\.(xlsx|docx|pptx|xlsm|docm|pptm)$/i.test(name) && depth < 3) walk(content, `${prefix}${name}!`, depth + 1);
    }
  };
  walk(bytes, '', 0);
  return out;
}

/** Decode XML entities and keep attribute values, so `string="CONFIDENTIAL"` and `&#26426;&#23494;` are both seen. */
function xmlText(xml: string): string {
  return xml
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function pdfChunks(bytes: Uint8Array): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const src = latin1.decode(bytes);
  // everything outside streams (dictionaries, strings, incremental-update leftovers)
  out.push({ where: 'PDF 結構', text: decodePdfStrings(src.replace(/stream\r?\n[\s\S]*?endstream/g, ' ')) });
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    n++;
    const data = decodeFilters(trimEol(bytes.subarray(start, end)), filtersBefore(src, m.index));
    const text = latin1.decode(data);
    out.push({ where: `串流 #${n}`, text: decodePdfStrings(text) + '\n' + utf8OrEmpty(data) });
    re.lastIndex = end + 9;
  }
  return out;
}

/** Filter names of the stream whose `stream` keyword is at `pos` (looks back into its dictionary). */
function filtersBefore(src: string, pos: number): string[] {
  const dictStart = src.lastIndexOf('obj', pos);
  const dict = src.slice(Math.max(dictStart, pos - 2000), pos);
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!m) return [];
  return [...m[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]!);
}

function decodeFilters(data: Uint8Array, filters: string[]): Uint8Array {
  let out = data;
  for (const f of filters) {
    try {
      if (f === 'FlateDecode' || f === 'Fl') out = inflate(out);
      else if (f === 'ASCII85Decode' || f === 'A85') out = ascii85(out);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') out = asciiHex(out);
      else break; // images (DCT, JPX, CCITT …) or LZW — nothing searchable
    } catch {
      break;
    }
  }
  return out;
}

function inflate(b: Uint8Array): Uint8Array {
  try {
    return unzlibSync(b);
  } catch {
    return inflateSync(b);
  }
}

export function ascii85(b: Uint8Array): Uint8Array {
  const s = latin1.decode(b).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function asciiHex(b: Uint8Array): Uint8Array {
  const s = latin1.decode(b).replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(Math.ceil(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((s.slice(i * 2, i * 2 + 2) + '0').slice(0, 2), 16);
  return out;
}

function trimEol(b: Uint8Array): Uint8Array {
  let e = b.length;
  while (e > 0 && (b[e - 1] === 0x0a || b[e - 1] === 0x0d)) e--;
  return b.subarray(0, e);
}

function utf8OrEmpty(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return '';
  }
}

/** Expand PDF hex strings and UTF-16BE literal strings so their text is searchable too. */
function decodePdfStrings(s: string): string {
  const extra: string[] = [];
  for (const m of s.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
    const hex = m[1]!.replace(/\s+/g, '');
    if (hex.length % 2) continue;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    extra.push(bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : latin1.decode(bytes));
  }
  return extra.length ? `${s}\n${extra.join('\n')}` : s;
}
