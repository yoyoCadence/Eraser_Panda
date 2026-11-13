import { applyCandidates, unitCandidates, type Candidate } from '../../core/candidates';
import { compileRules } from '../../core/matcher';
import type { FormatHandler, ScanContext, ScanResult } from '../../core/types';
import { applyPlan, scanPageText } from './content/textScan';
import { dropImageResources, scanPdfImages } from './images';
import { scanPdfMetadata } from './metadata';
import { loadPdf, savePdf } from './pdfdoc';
import { scanAnnotations, scanAttachments, scanOutlines } from './structure';

async function collect(bytes: Uint8Array, ctx: ScanContext) {
  const doc = await loadPdf(bytes);
  const compiled = compileRules(ctx.rules);
  const meta = scanPdfMetadata(doc, compiled);
  const units = [...meta.units, ...scanOutlines(doc)];
  const attachments = scanAttachments(doc);
  const text = scanPageText(doc, compiled);
  const images = await scanPdfImages(doc, text, ctx);
  const candidates: Candidate[] = [...text.candidates, ...images, ...unitCandidates(units, compiled), ...meta.candidates, ...scanAnnotations(doc, compiled), ...attachments.candidates];
  const warnings: string[] = [];
  if (text.undecodable > 0) warnings.push(`有 ${text.undecodable} 個字元因字型缺少字元對照表（ToUnicode）而無法辨識，這些文字無法被偵測。`);
  if (!text.result.runs.length && doc.getPageCount() > 0) warnings.push('頁面上沒有可辨識的文字（可能是掃描影像或文字已轉為外框），只能處理 metadata 與註解。');
  return {
    doc,
    candidates,
    warnings,
    finalize: [attachments.finalize, () => applyPlan(doc, text), () => dropImageResources(doc, text.dropXObjects)],
  };
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
