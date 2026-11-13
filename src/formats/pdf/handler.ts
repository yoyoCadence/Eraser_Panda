import { applyCandidates, unitCandidates, type Candidate } from '../../core/candidates';
import { compileRules } from '../../core/matcher';
import type { FormatHandler, ScanContext, ScanResult } from '../../core/types';
import { scanPdfMetadata } from './metadata';
import { loadPdf, savePdf } from './pdfdoc';
import { scanAnnotations, scanAttachments, scanOutlines } from './structure';

async function collect(bytes: Uint8Array, ctx: ScanContext) {
  const doc = await loadPdf(bytes);
  const compiled = compileRules(ctx.rules);
  const meta = scanPdfMetadata(doc, compiled);
  const units = [...meta.units, ...scanOutlines(doc)];
  const attachments = scanAttachments(doc);
  const candidates: Candidate[] = [...unitCandidates(units, compiled), ...meta.candidates, ...scanAnnotations(doc, compiled), ...attachments.candidates];
  // TODO(M5): remove once page content (text drawn on the page) is scanned.
  const warnings: string[] = ['目前版本只處理 PDF 的 metadata、註解、書籤與附件；頁面上直接繪製的文字（頁首頁尾、浮水印、內文）將在下一版支援。'];
  return { doc, candidates, warnings, finalize: [attachments.finalize] };
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
