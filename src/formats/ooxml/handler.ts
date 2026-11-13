import { compileRules, type CompiledRules } from '../../core/matcher';
import { detectFormat } from '../../core/fileType';
import type { FormatHandler, FormatId, ScanContext, ScanResult } from '../../core/types';
import { collectDocx } from './docx';
import { collectChart, collectDmlParagraphs } from './drawingml';
import { scanMetadata } from './metadata';
import { OoxmlPackage } from './package';
import { collectPptx } from './pptx';
import { applyCandidates, unitCandidates, type Candidate, type TextUnit } from './units';
import { NS, els } from './xml';
import { collectXlsx, workbookPath } from './xlsx';

type OoxmlFormat = 'docx' | 'xlsx' | 'pptx';

interface Collected {
  pkg: OoxmlPackage;
  candidates: Candidate[];
  warnings: string[];
  pageCount?: number;
  /** nested packages to re-save into the parent after applying, deepest first */
  finalizers: Array<() => void>;
}

function collect(pkg: OoxmlPackage, format: OoxmlFormat, compiled: CompiledRules, prefix: string, depth: number): Collected {
  const warnings: string[] = [];
  const finalizers: Array<() => void> = [];
  let units: TextUnit[] = [];
  let extra: Candidate[] = [];
  let pageCount: number | undefined;

  if (format === 'docx') {
    units = collectDocx(pkg);
    for (const path of pkg.paths) {
      const ct = pkg.contentType(path) ?? '';
      if (ct.includes('drawingml.chart+xml')) units.push(...collectChart(pkg, path, '圖表'));
      else if (ct.includes('diagramData+xml') || ct.includes('diagramDrawing+xml')) units.push(...collectDmlParagraphs(pkg, path, { location: 'body', where: 'SmartArt 圖形' }));
    }
  } else if (format === 'xlsx') {
    const r = collectXlsx(pkg, compiled);
    units = r.units;
    extra = r.candidates;
    const wb = workbookPath(pkg);
    const wbDoc = wb ? pkg.xml(wb) : undefined;
    pageCount = wbDoc ? els(wbDoc, NS.s, 'sheet').length : undefined;
  } else {
    units = collectPptx(pkg);
    pageCount = units.reduce((m, u) => Math.max(m, u.location === 'body' ? (u.page ?? 0) : 0), 0) || undefined;
  }

  const meta = scanMetadata(pkg, compiled);
  units = dedupe([...units, ...meta.units]);
  const candidates = [...unitCandidates(units, compiled, prefix), ...prefixed(extra, prefix), ...prefixed(meta.candidates, prefix)];

  // ---- embedded Office files (chart data workbooks, embedded documents) — processed recursively ----
  for (const path of pkg.paths.filter((p) => /\/embeddings\//.test(p))) {
    const bytes = pkg.bytes(path)!;
    const det = detectFormat(path, bytes);
    if (det.ok && (det.format === 'docx' || det.format === 'xlsx' || det.format === 'pptx') && depth < 3) {
      try {
        const child = new OoxmlPackage(bytes);
        const sub = collect(child, det.format, compiled, `${prefix}${path}!`, depth + 1);
        for (const c of sub.candidates) {
          c.finding.where = `內嵌檔案 ${path.slice(path.lastIndexOf('/') + 1)}・${c.finding.where}`;
          c.finding.page = undefined;
        }
        candidates.push(...sub.candidates);
        warnings.push(...sub.warnings);
        const touched = () => sub.candidates.some((c) => c.touched);
        finalizers.push(...sub.finalizers, () => {
          if (touched()) pkg.setBytes(path, child.save());
        });
      } catch {
        warnings.push(`內嵌檔案 ${path} 無法解析，未檢查。`);
      }
    } else if (/\.(bin|ole)$/i.test(path) || det.ok === false) {
      warnings.push(`包含無法檢查的內嵌物件（${path.slice(path.lastIndexOf('/') + 1)}），其中可能仍含標籤字眼。`);
    }
  }

  if (pkg.paths.some((p) => /vbaProject\.bin$/i.test(p))) warnings.push('文件含有巨集（VBA），巨集程式碼內的字串不會被檢查。');
  const root = pkg.paths.find((p) => /^(word\/document|xl\/workbook|ppt\/presentation)\.xml$/.test(p));
  if (root && pkg.text(root)?.includes('http://purl.oclc.org/ooxml/')) warnings.push('此檔案為 Strict Open XML 格式，部分位置可能無法偵測。建議在 Office 中另存為一般格式。');

  return { pkg, candidates, warnings, pageCount, finalizers };
}

function dedupe(units: TextUnit[]): TextUnit[] {
  const seen = new Set<string>();
  return units.filter((u) => {
    const k = `${u.part}#${u.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function prefixed(list: Candidate[], prefix: string): Candidate[] {
  if (prefix) for (const c of list) c.finding.id = prefix + c.finding.id;
  return list;
}

export function createOoxmlHandler(id: OoxmlFormat): FormatHandler {
  return {
    id,
    async scan(input: Uint8Array, ctx: ScanContext): Promise<ScanResult> {
      const compiled = compileRules(ctx.rules);
      const c = collect(new OoxmlPackage(input), id, compiled, '', 0);
      return {
        format: id as FormatId,
        findings: c.candidates.map((x) => x.finding),
        warnings: c.warnings,
        pageCount: c.pageCount,
      };
    },
    async apply(input: Uint8Array, ctx: ScanContext, removeIds: ReadonlySet<string>): Promise<Uint8Array> {
      const compiled = compileRules(ctx.rules);
      const c = collect(new OoxmlPackage(input), id, compiled, '', 0);
      const selected = c.candidates.filter((x) => x.finding.removable && removeIds.has(x.finding.id));
      for (const s of selected) s.touched = true;
      applyCandidates(selected);
      for (const f of c.finalizers) f();
      return c.pkg.save();
    },
  };
}

export const docxHandler = createOoxmlHandler('docx');
export const xlsxHandler = createOoxmlHandler('xlsx');
export const pptxHandler = createOoxmlHandler('pptx');
