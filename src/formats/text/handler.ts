import { compileRules } from '../../core/matcher';
import { cutPieces, matchSegments, type Piece } from '../../core/segments';
import type { Finding, FormatHandler, ScanContext, ScanResult } from '../../core/types';

interface Decoded {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'big5' | 'gb18030' | 'shift_jis';
  bom: boolean;
}

/** UTF-8 / UTF-16 (BOM) first; otherwise try legacy CJK encodings common for CSV exported from Excel. */
export function decodeText(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false };
  } catch {
    /* not UTF-8 */
  }
  for (const enc of ['big5', 'gb18030', 'shift_jis'] as const) {
    try {
      return { text: new TextDecoder(enc, { fatal: true }).decode(bytes), encoding: enc, bom: false };
    } catch {
      /* try next */
    }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', bom: false };
}

function encodeText(text: string, d: Decoded): Uint8Array {
  if (d.encoding === 'utf-16le' || d.encoding === 'utf-16be') {
    const out = new Uint8Array(2 + text.length * 2);
    const le = d.encoding === 'utf-16le';
    out[0] = le ? 0xff : 0xfe;
    out[1] = le ? 0xfe : 0xff;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = le ? c & 0xff : c >> 8;
      out[3 + i * 2] = le ? c >> 8 : c & 0xff;
    }
    return out;
  }
  // Browsers can only encode UTF-8. Legacy encodings are written as UTF-8 with BOM so Excel still opens CSV correctly.
  const body = new TextEncoder().encode(text);
  if (!d.bom && d.encoding === 'utf-8') return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

function analyse(bytes: Uint8Array, ctx: ScanContext) {
  const decoded = decodeText(bytes);
  const compiled = compileRules(ctx.rules);
  const lines = decoded.text.split(/(?<=\n)/);
  const findings: Finding[] = [];
  const cuts = new Map<string, { line: number; pieces: Piece[] }>();
  lines.forEach((line, i) => {
    for (const h of matchSegments([{ text: line.replace(/\r?\n$/, '') }], compiled)) {
      const id = `L${i + 1}:${h.start}-${h.end}`;
      findings.push({
        id,
        kind: 'text',
        location: 'body',
        ruleId: h.ruleId,
        matchText: h.text,
        context: h.context,
        where: `第 ${i + 1} 行`,
        page: undefined,
        confidence: h.wholeUnit ? 'high' : 'medium',
        removable: true,
        defaultSelected: true,
      });
      cuts.set(id, { line: i, pieces: h.pieces });
    }
  });
  return { decoded, lines, findings, cuts };
}

export const textHandler: FormatHandler = {
  id: 'text',
  async scan(bytes, ctx): Promise<ScanResult> {
    const { decoded, findings, lines, cuts } = analyse(bytes, ctx);
    const hitLines = new Map<number, Array<{ start: number; end: number; id: string }>>();
    for (const f of findings) {
      const m = /^L(\d+):(\d+)-(\d+)$/.exec(f.id)!;
      const n = Number(m[1]) - 1;
      hitLines.set(n, [...(hitLines.get(n) ?? []), { start: Number(m[2]), end: Number(m[3]), id: f.id }]);
    }
    void cuts;
    const shown = [...new Set([...hitLines.keys()].flatMap((n) => [n - 1, n, n + 1]))].filter((n) => n >= 0 && n < lines.length).sort((a, b) => a - b);
    const previewLines = shown.slice(0, 400).flatMap((n, i) => [
      ...(i > 0 && n !== shown[i - 1]! + 1 ? [{ text: '…', marks: [] }] : []),
      { text: lines[n]!.replace(/\r?\n$/, ''), marks: hitLines.get(n) ?? [], tag: `${n + 1}` },
    ]);
    const warnings = decoded.encoding !== 'utf-8' && decoded.encoding !== 'utf-16le' && decoded.encoding !== 'utf-16be' ? [`原檔編碼為 ${decoded.encoding.toUpperCase()}，輸出檔將改為 UTF-8（含 BOM），Excel 仍可正常開啟。`] : [];
    return { format: 'text', findings, warnings, preview: previewLines.length ? [{ title: '檔案內容', lines: previewLines }] : [] };
  },
  async apply(bytes, ctx, removeIds) {
    const { decoded, lines, cuts } = analyse(bytes, ctx);
    const byLine = new Map<number, Piece[]>();
    for (const [id, c] of cuts) {
      if (!removeIds.has(id)) continue;
      byLine.set(c.line, [...(byLine.get(c.line) ?? []), ...c.pieces]);
    }
    const out = lines.map((line, i) => {
      const pieces = byLine.get(i);
      if (!pieces) return line;
      const eol = /\r?\n$/.exec(line)?.[0] ?? '';
      return cutPieces([line.slice(0, line.length - eol.length)], pieces)[0] + eol;
    });
    return encodeText(out.join(''), decoded);
  },
};
