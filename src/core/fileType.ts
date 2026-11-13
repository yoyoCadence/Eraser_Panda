import { unzipSync } from 'fflate';
import type { FormatId } from './types';

export type DetectResult =
  | { ok: true; format: FormatId }
  | { ok: false; reason: 'legacy-office' | 'encrypted-office' | 'unsupported' | 'corrupt'; message: string };

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'log']);

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** `%PDF-` may legally appear anywhere in the first 1024 bytes. */
function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * Identify the format from magic bytes first and the extension second.
 * The extension alone is not trusted: a renamed .docx that is really a zip of a spreadsheet must be detected as xlsx.
 */
export function detectFormat(name: string, bytes: Uint8Array): DetectResult {
  const ext = extOf(name);

  if (looksLikePdf(bytes)) return { ok: true, format: 'pdf' };

  if (startsWith(bytes, CFB_MAGIC)) {
    // OLE compound file: either a legacy binary Office file, or an OOXML file wrapped by password / IRM (RMS) encryption.
    const isEncryptedOoxml = ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm'].includes(ext) || containsUtf16(bytes, 'EncryptedPackage');
    if (isEncryptedOoxml) {
      return {
        ok: false,
        reason: 'encrypted-office',
        message:
          '此檔案已加密（密碼保護或 Microsoft Purview / RMS 敏感度標籤加密）。本工具無法、也不應解密。請先在 Office 中移除密碼或將標籤調整為不加密的層級後再試。',
      };
    }
    return {
      ok: false,
      reason: 'legacy-office',
      message: '這是舊版二進位 Office 格式（.doc / .xls / .ppt）。請先在 Office 中「另存新檔」為 .docx / .xlsx / .pptx 後再處理。',
    };
  }

  if (startsWith(bytes, ZIP_MAGIC)) {
    const fmt = sniffOoxml(bytes);
    if (fmt) return { ok: true, format: fmt };
    return { ok: false, reason: 'unsupported', message: '這是 ZIP 檔，但不是可處理的 Word / Excel / PowerPoint 文件。' };
  }

  if (TEXT_EXT.has(ext)) return { ok: true, format: 'text' };

  return { ok: false, reason: 'unsupported', message: `不支援的檔案類型（.${ext || '無副檔名'}）。支援：PDF、DOCX、XLSX、PPTX、TXT、CSV、MD。` };
}

function sniffOoxml(bytes: Uint8Array): FormatId | null {
  let ct: Uint8Array | undefined;
  try {
    const entries = unzipSync(bytes, { filter: (f) => f.name === '[Content_Types].xml' });
    ct = entries['[Content_Types].xml'];
  } catch {
    return null;
  }
  if (!ct) return null;
  const xml = new TextDecoder().decode(ct);
  if (xml.includes('wordprocessingml.document.main') || xml.includes('wordprocessingml.template.main') || xml.includes('ms-word.document.macroEnabled') || xml.includes('ms-word.template.macroEnabled')) return 'docx';
  if (xml.includes('spreadsheetml.sheet.main') || xml.includes('spreadsheetml.template.main') || xml.includes('ms-excel.sheet.macroEnabled') || xml.includes('ms-excel.template.macroEnabled')) return 'xlsx';
  if (xml.includes('presentationml.presentation.main') || xml.includes('presentationml.slideshow.main') || xml.includes('presentationml.template.main') || xml.includes('ms-powerpoint.presentation.macroEnabled') || xml.includes('ms-powerpoint.slideshow.macroEnabled')) return 'pptx';
  return null;
}

function containsUtf16(bytes: Uint8Array, s: string): boolean {
  const needle = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) needle[i * 2] = s.charCodeAt(i);
  const limit = Math.min(bytes.length, 1 << 20) - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** `report.pdf` → `report_clean.pdf` */
export function cleanFileName(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? `${name}_clean` : `${name.slice(0, i)}_clean${name.slice(i)}`;
}
