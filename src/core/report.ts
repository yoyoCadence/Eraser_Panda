import type { Finding, FormatId } from './types';

export interface ReportFile {
  file: string;
  format: FormatId;
  outputName: string;
  processedAt: string;
  sizeIn: number;
  sizeOut: number;
  sha256In?: string;
  sha256Out?: string;
  removed: Finding[];
  kept: Finding[];
  manual: Finding[];
  warnings: string[];
  residual: number;
  rawResidual: number;
}

export const TOOL = 'Eraser Panda';

/** Hex SHA-256 via WebCrypto; undefined when unavailable (non-secure context). */
export async function sha256(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

const KIND: Record<string, string> = { text: '文字', metadata: 'Metadata', image: '圖片 / Logo', watermark: '浮水印', annotation: '註解' };

/**
 * Audit report. Deliberately contains only the removed label text and its location — never the surrounding document
 * content — so the report itself does not leak what the documents say.
 */
export function reportJson(files: ReportFile[]): string {
  return JSON.stringify(
    {
      tool: TOOL,
      generatedAt: new Date().toISOString(),
      note: '本報告僅列出被移除 / 保留的標籤字眼與位置，不含文件其他內容。',
      files: files.map((f) => ({
        ...f,
        removed: f.removed.map(slim),
        kept: f.kept.map(slim),
        manual: f.manual.map(slim),
      })),
    },
    null,
    2,
  );
}

function slim(f: Finding) {
  return { kind: f.kind, location: f.location, where: f.where, text: f.matchText, confidence: f.confidence };
}

export function reportCsv(files: ReportFile[]): string {
  const rows: string[][] = [['檔案', '輸出檔', '處理時間', '原檔 SHA-256', '輸出 SHA-256', '動作', '類型', '位置', '內容', '驗證殘留', '原始位元組殘留']];
  for (const f of files) {
    const base = [f.file, f.outputName, f.processedAt, f.sha256In ?? '', f.sha256Out ?? ''];
    const tail = [String(f.residual), String(f.rawResidual)];
    const add = (action: string, list: Finding[]) => list.forEach((x) => rows.push([...base, action, KIND[x.kind] ?? x.kind, x.where, x.matchText, ...tail]));
    add('已移除', f.removed);
    add('保留（例外）', f.kept);
    add('需手動處理', f.manual);
    if (!f.removed.length && !f.kept.length && !f.manual.length) rows.push([...base, '無發現', '', '', '', ...tail]);
  }
  // BOM so Excel opens UTF-8 correctly; formula-like cells are neutralised (CSV injection)
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
