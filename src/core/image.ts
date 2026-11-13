import { unzlibSync, zlibSync } from 'fflate';

export interface Pixels {
  w: number;
  h: number;
  /** RGBA, 8 bits per channel */
  data: Uint8ClampedArray | Uint8Array;
}

/** Decodes encoded image bytes (JPEG, GIF, WebP …) to pixels — injected by the browser UI; unavailable in tests. */
export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<Pixels | null>;

// ---------------------------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngEncode(p: Pixels): Uint8Array {
  const raw = new Uint8Array((p.w * 4 + 1) * p.h);
  for (let y = 0; y < p.h; y++) {
    raw[y * (p.w * 4 + 1)] = 0;
    raw.set(p.data.subarray(y * p.w * 4, (y + 1) * p.w * 4), y * (p.w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, p.w);
  dv.setUint32(4, p.h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/** Minimal PNG decoder (8-bit, non-interlaced; grey / RGB / palette / grey+alpha / RGBA). Returns null otherwise. */
export function pngDecode(bytes: Uint8Array): Pixels | null {
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(pos + 8);
      h = dv.getUint32(pos + 12);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || !w || !h || w * h > 16_000_000) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) return null;
  let compressed: Uint8Array;
  if (idat.length === 1) compressed = idat[0]!;
  else {
    compressed = new Uint8Array(idat.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of idat) {
      compressed.set(x, o);
      o += x.length;
    }
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(compressed);
  } catch {
    return null;
  }
  const stride = w * channels;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]!;
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
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
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const s = x * channels;
      if (ctype === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[s]!;
        out[o + 3] = 255;
      } else if (ctype === 2) {
        out[o] = line[s]!;
        out[o + 1] = line[s + 1]!;
        out[o + 2] = line[s + 2]!;
        out[o + 3] = 255;
      } else if (ctype === 3) {
        const i = line[s]!;
        out[o] = palette?.[i * 3] ?? 0;
        out[o + 1] = palette?.[i * 3 + 1] ?? 0;
        out[o + 2] = palette?.[i * 3 + 2] ?? 0;
        out[o + 3] = trns && i < trns.length ? trns[i]! : 255;
      } else if (ctype === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[s]!;
        out[o + 3] = line[s + 1]!;
      } else {
        out[o] = line[s]!;
        out[o + 1] = line[s + 1]!;
        out[o + 2] = line[s + 2]!;
        out[o + 3] = line[s + 3]!;
      }
    }
    prev = line;
  }
  return { w, h, data: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Perceptual hash
// ---------------------------------------------------------------------------------------------------------------

/** Grey value at (x, y) after compositing on white (transparent logo backgrounds must not matter). */
function grey(p: Pixels, x: number, y: number): number {
  const o = (y * p.w + x) * 4;
  const a = p.data[o + 3]! / 255;
  const g = 0.299 * p.data[o]! + 0.587 * p.data[o + 1]! + 0.114 * p.data[o + 2]!;
  return g * a + 255 * (1 - a);
}

/** Box-filter downscale to gw × gh grey values. */
function shrink(p: Pixels, gw: number, gh: number): number[] {
  const out: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * p.h) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * p.h) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * p.w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * p.w) / gw));
      let sum = 0;
      let n = 0;
      const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 8));
      for (let y = y0; y < y1; y += stepY)
        for (let x = x0; x < x1; x += stepX) {
          sum += grey(p, Math.min(x, p.w - 1), Math.min(y, p.h - 1));
          n++;
        }
      out.push(sum / n);
    }
  }
  return out;
}

/**
 * 64-bit difference hash + aspect ratio, as a string `"<16 hex>@<ratio>"`. Robust to scaling and recompression,
 * which is what happens to a logo pasted into many documents.
 */
export function logoHash(p: Pixels): string {
  const g = shrink(p, 9, 8);
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x]! > g[y * 9 + x + 1]! ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return `${hex}@${(p.w / p.h).toFixed(3)}`;
}

/** Similarity of two logo hashes: true when the images are very likely the same logo. */
export function sameLogo(a: string, b: string, maxDistance = 10): boolean {
  const [ha, ra] = a.split('@');
  const [hb, rb] = b.split('@');
  if (!ha || !hb || ha.length !== hb.length) return false;
  const r1 = Number(ra);
  const r2 = Number(rb);
  if (r1 && r2 && Math.max(r1, r2) / Math.min(r1, r2) > 1.3) return false;
  let d = 0;
  for (let i = 0; i < ha.length; i++) {
    let x = parseInt(ha[i]!, 16) ^ parseInt(hb[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d <= maxDistance;
}

/** Scale pixels down to fit in `max` (for thumbnails). */
export function thumbnail(p: Pixels, max = 96): Pixels {
  const s = Math.min(1, max / Math.max(p.w, p.h));
  if (s === 1) return p;
  const w = Math.max(1, Math.round(p.w * s));
  const h = Math.max(1, Math.round(p.h * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(p.w - 1, Math.floor(x / s));
      const sy = Math.min(p.h - 1, Math.floor(y / s));
      out.set(p.data.subarray((sy * p.w + sx) * 4, (sy * p.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  return { w, h, data: out };
}

export function dataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

export function mimeOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf' }[ext];
}
