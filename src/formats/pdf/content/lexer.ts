/**
 * PDF content-stream lexer/parser.
 *
 * Produces a list of instructions (operands + operator) with their exact byte ranges, so that a rewrite can replace
 * only the instructions it changed and keep every other byte of the stream identical.
 */

export type Obj =
  | { t: 'num'; v: number }
  | { t: 'str'; v: Uint8Array; hex: boolean }
  | { t: 'name'; v: string }
  | { t: 'arr'; v: Obj[] }
  | { t: 'dict'; v: Map<string, Obj> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

export interface Instr {
  op: string;
  args: Obj[];
  /** byte offset of the first operand (or the operator when there are none) */
  start: number;
  /** byte offset just after the operator (for BI: after EI) */
  end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

export function parseContent(data: Uint8Array): Instr[] {
  const out: Instr[] = [];
  let i = 0;
  const n = data.length;
  // operand stack; containers being built are tracked separately
  let operands: Obj[] = [];
  let opStart = -1;
  const containers: Array<{ kind: 'arr' | 'dict'; items: Obj[] }> = [];

  const push = (o: Obj, at: number) => {
    if (containers.length) containers[containers.length - 1]!.items.push(o);
    else {
      if (opStart < 0) opStart = at;
      operands.push(o);
    }
  };

  while (i < n) {
    const c = data[i]!;
    if (WS.has(c)) {
      i++;
      continue;
    }
    const tokStart = i;
    if (c === 0x25) {
      // % comment
      while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      const [bytes, next] = readLiteral(data, i);
      i = next;
      push({ t: 'str', v: bytes, hex: false }, tokStart);
      continue;
    }
    if (c === 0x3c) {
      if (data[i + 1] === 0x3c) {
        if (!containers.length && opStart < 0) opStart = i;
        containers.push({ kind: 'dict', items: [] });
        i += 2;
        continue;
      }
      const [bytes, next] = readHex(data, i);
      i = next;
      push({ t: 'str', v: bytes, hex: true }, tokStart);
      continue;
    }
    if (c === 0x3e && data[i + 1] === 0x3e) {
      i += 2;
      const top = containers.pop();
      if (top) push(toDict(top.items), tokStart);
      continue;
    }
    if (c === 0x5b) {
      if (!containers.length && opStart < 0) opStart = i;
      containers.push({ kind: 'arr', items: [] });
      i++;
      continue;
    }
    if (c === 0x5d) {
      i++;
      const top = containers.pop();
      if (top) push({ t: 'arr', v: top.items }, tokStart);
      continue;
    }
    if (c === 0x2f) {
      i++;
      const s = i;
      while (i < n && isRegular(data[i]!)) i++;
      push({ t: 'name', v: decodeName(data.subarray(s, i)) }, tokStart);
      continue;
    }
    if (c === 0x7b || c === 0x7d || c === 0x29 || c === 0x3e) {
      i++; // stray delimiters (PostScript calculator braces etc.) — ignore
      continue;
    }
    // regular token: number or keyword
    const s = i;
    while (i < n && isRegular(data[i]!)) i++;
    const tok = latin1(data.subarray(s, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      push({ t: 'num', v: parseFloat(tok) }, tokStart);
      continue;
    }
    if (tok === 'true' || tok === 'false') {
      push({ t: 'bool', v: tok === 'true' }, tokStart);
      continue;
    }
    if (tok === 'null') {
      push({ t: 'null' }, tokStart);
      continue;
    }
    if (containers.length) {
      // keyword inside an array/dict is malformed — drop the containers to resync
      containers.length = 0;
    }
    if (tok === 'BI') {
      const start = opStart >= 0 ? opStart : tokStart;
      const { dict, end } = readInlineImage(data, i);
      out.push({ op: 'BI', args: [dict], start, end });
      i = end;
    } else {
      out.push({ op: tok, args: operands, start: opStart >= 0 ? opStart : tokStart, end: i });
    }
    operands = [];
    opStart = -1;
  }
  return out;
}

function toDict(items: Obj[]): Obj {
  const m = new Map<string, Obj>();
  for (let k = 0; k + 1 < items.length; k += 2) {
    const key = items[k]!;
    if (key.t === 'name') m.set(key.v, items[k + 1]!);
  }
  return { t: 'dict', v: m };
}

function readLiteral(data: Uint8Array, start: number): [Uint8Array, number] {
  const out: number[] = [];
  let i = start + 1;
  let depth = 1;
  while (i < data.length) {
    const c = data[i]!;
    if (c === 0x5c) {
      const d = data[i + 1];
      i += 2;
      switch (d) {
        case 0x6e: out.push(0x0a); break; // \n
        case 0x72: out.push(0x0d); break; // \r
        case 0x74: out.push(0x09); break; // \t
        case 0x62: out.push(0x08); break; // \b
        case 0x66: out.push(0x0c); break; // \f
        case 0x0d: if (data[i] === 0x0a) i++; break; // line continuation
        case 0x0a: break;
        case undefined: break;
        default:
          if (d >= 0x30 && d <= 0x37) {
            let v = d - 0x30;
            for (let k = 0; k < 2 && data[i]! >= 0x30 && data[i]! <= 0x37; k++) v = v * 8 + (data[i++]! - 0x30);
            out.push(v & 0xff);
          } else out.push(d);
      }
      continue;
    }
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return [Uint8Array.from(out), i + 1];
    out.push(c);
    i++;
  }
  return [Uint8Array.from(out), i];
}

function readHex(data: Uint8Array, start: number): [Uint8Array, number] {
  let i = start + 1;
  const digits: number[] = [];
  while (i < data.length && data[i] !== 0x3e) {
    const c = data[i]!;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v >= 0) digits.push(v);
    i++;
  }
  if (digits.length % 2) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = (digits[k * 2]! << 4) | digits[k * 2 + 1]!;
  return [out, i + 1];
}

function decodeName(b: Uint8Array): string {
  const s = latin1(b);
  return s.includes('#') ? s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s;
}

/** BI <key value>* ID <binary> EI — find EI robustly (binary data may contain "EI"). */
function readInlineImage(data: Uint8Array, from: number): { dict: Obj; end: number } {
  // parse dictionary entries up to ID with a nested mini-parse
  let i = from;
  let idPos = -1;
  while (i < data.length - 1) {
    if (data[i] === 0x49 && data[i + 1] === 0x44 && WS.has(data[i - 1] ?? 0x20) && (WS.has(data[i + 2] ?? 0x20) || i + 2 >= data.length)) {
      idPos = i;
      break;
    }
    i++;
  }
  const dict: Obj = idPos > 0 ? toDict(tokenizeOperands(data.subarray(from, idPos))) : { t: 'dict', v: new Map() };
  let j = idPos < 0 ? data.length : idPos + 3;
  while (j < data.length - 1) {
    if (data[j] === 0x45 && data[j + 1] === 0x49 && WS.has(data[j - 1]!) && (j + 2 >= data.length || WS.has(data[j + 2]!) || DELIM.has(data[j + 2]!))) {
      return { dict, end: j + 2 };
    }
    j++;
  }
  return { dict, end: data.length };
}

/** Operands only (no operator) — used for inline image dictionaries. */
function tokenizeOperands(data: Uint8Array): Obj[] {
  const withOp = new Uint8Array(data.length + 3);
  withOp.set(data);
  withOp.set([0x20, 0x5f, 0x5f], data.length); // " __" sentinel operator
  const instrs = parseContent(withOp);
  return instrs[0]?.args ?? [];
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization of rewritten instructions
// ---------------------------------------------------------------------------------------------------------------

export function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function hexString(b: Uint8Array): string {
  let s = '<';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return `${s}>`;
}
