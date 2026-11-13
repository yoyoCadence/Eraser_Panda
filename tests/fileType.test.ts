import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cleanFileName, detectFormat } from '../src/core/fileType';

const ct = (main: string) =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/x" ContentType="application/vnd.openxmlformats-officedocument.${main}+xml"/></Types>`;

describe('detectFormat', () => {
  it('detects OOXML by content types, not extension', () => {
    const xlsx = zipSync({ '[Content_Types].xml': strToU8(ct('spreadsheetml.sheet.main')) });
    expect(detectFormat('renamed.docx', xlsx)).toEqual({ ok: true, format: 'xlsx' });
    const docx = zipSync({ '[Content_Types].xml': strToU8(ct('wordprocessingml.document.main')) });
    expect(detectFormat('a.docx', docx)).toEqual({ ok: true, format: 'docx' });
    const pptx = zipSync({ '[Content_Types].xml': strToU8(ct('presentationml.presentation.main')) });
    expect(detectFormat('a.pptx', pptx)).toEqual({ ok: true, format: 'pptx' });
  });

  it('detects PDF even with leading garbage', () => {
    expect(detectFormat('x.bin', strToU8('\n\n%PDF-1.7\n'))).toEqual({ ok: true, format: 'pdf' });
  });

  it('rejects legacy and encrypted Office files with actionable messages', () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const legacy = detectFormat('old.doc', cfb);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.reason).toBe('legacy-office');
    const enc = detectFormat('locked.docx', cfb);
    expect(enc.ok).toBe(false);
    if (!enc.ok) expect(enc.reason).toBe('encrypted-office');
  });

  it('accepts plain text by extension and rejects unknown files', () => {
    expect(detectFormat('notes.md', strToU8('# hi'))).toEqual({ ok: true, format: 'text' });
    expect(detectFormat('photo.png', new Uint8Array([0x89, 0x50]))).toMatchObject({ ok: false, reason: 'unsupported' });
  });
});

describe('cleanFileName', () => {
  it('appends _clean before the extension', () => {
    expect(cleanFileName('report.final.pdf')).toBe('report.final_clean.pdf');
    expect(cleanFileName('README')).toBe('README_clean');
    expect(cleanFileName('.env')).toBe('.env_clean');
  });
});
