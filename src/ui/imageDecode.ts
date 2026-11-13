import type { ImageDecoder, Pixels } from '../core/image';

/** Decode JPEG / PNG / GIF / WebP / BMP with the browser, downscaled to at most 256 px (enough for hashing + thumbs). */
export const browserDecode: ImageDecoder = async (bytes, mime) => {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    return bitmapPixels(bmp);
  } catch {
    return null;
  }
};

export function bitmapPixels(bmp: ImageBitmap, max = 256): Pixels | null {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(bmp, 0, 0, w, h);
  return { w, h, data: g.getImageData(0, 0, w, h).data };
}
