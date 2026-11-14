import { applyCandidates, unitCandidates, type Candidate } from '../../core/candidates';
import { compileRules } from '../../core/matcher';
import type { FormatHandler, ScanContext, ScanResult } from '../../core/types';
import { applyPlan, scanPageText } from './content/textScan';
import { dropImageResources, scanPdfImages } from './images';
import { scanPdfMetadata } from './metadata';
import { loadPdf, normRect, savePdf } from './pdfdoc';
import { scanAnnotations, scanAttachments, scanFormFields, scanOutlines, scanStructTree } from './structure';

async function collect(bytes: Uint8Array, ctx: ScanContext) {
  const doc = await loadPdf(bytes);
  const compiled = compileRules(ctx.rules);
  const meta = scanPdfMetadata(doc, compiled);
  const form = scanFormFields(doc);
  const units = [...meta.units, ...scanOutlines(doc), ...form.units, ...scanStructTree(doc)];
  const attachments = scanAttachments(doc);
  const text = scanPageText(doc, compiled);
  const images = await scanPdfImages(doc, text, ctx);
  const candidates: Candidate[] = [...text.candidates, ...images, ...unitCandidates(units, compiled), ...meta.candidates, ...scanAnnotations(doc, compiled), ...attachments.candidates];
  const warnings: string[] = [...form.warnings];
  if (text.undecodable > 0) warnings.push(`有 ${text.undecodable} 個字元因字型缺少字元對照表（ToUnicode）而無法辨識，這些文字無法被偵測。`);
  if (!text.result.runs.length && doc.getPageCount() > 0) warnings.push('頁面上沒有可辨識的文字（可能是掃描影像或文字已轉為外框），只能處理 metadata 與註解。');
  const scannedPages = scannedPagesOf(doc, text.result);
  if (scannedPages.length)
    warnings.push(
      `第 ${scannedPages.slice(0, 5).join('、')}${scannedPages.length > 5 ? ' 等' : ''} 頁是掃描影像（含 OCR 文字層）：本工具只能移除可搜尋的文字與 metadata，影像中看得到的標籤與 Logo 無法移除。請盡量改用原始電子檔。`,
    );
  return {
    doc,
    candidates,
    warnings,
    finalize: [attachments.finalize, form.finalize, () => applyPlan(doc, text), () => dropImageResources(doc, text.dropXObjects)],
  };
}

/** Pages whose content is essentially one big image (a scan) — with or without an invisible OCR layer. */
function scannedPagesOf(doc: import('pdf-lib').PDFDocument, res: import('./content/interpret').InterpretResult): number[] {
  const pages = new Set<number>();
  for (const im of res.images) {
    const xs = im.quad.map((q) => q[0]);
    const ys = im.quad.map((q) => q[1]);
    const r = normRect(doc, im.page - 1, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    if (r.w * r.h > 0.6) pages.add(im.page);
  }
  const visibleText = new Set(res.runs.filter((r) => !r.invisible && r.glyphs.length).map((r) => r.page));
  return [...pages].filter((p) => !visibleText.has(p)).sort((a, b) => a - b);
}

export const pdfHandler: FormatHandler = {
  id: 'pdf',
  async scan(bytes, ctx): Promise<ScanResult> {
    const { doc, candidates, warnings } = await collect(bytes, ctx);
    return { format: 'pdf', findings: candidates.map((c) => c.finding), warnings, pageCount: doc.getPageCount() };
  },
  async apply(bytes, ctx, removeIds) {
    const { doc, candidates, finalize } = await collect(bytes, ctx);
    applyCandidates(candidates.filter((c) => c.finding.removable && removeIds.has(c.finding.id)));
    for (const f of finalize) f();
    return savePdf(doc);
  },
};
