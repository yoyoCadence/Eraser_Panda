import { zipSync } from 'fflate';
import { cleanFileName, detectFormat } from '../core/fileType';
import { compileRules } from '../core/matcher';
import { sha256, type ReportFile } from '../core/report';
import { rawScan, type RawHit } from '../verify/raw';
import type { FormatId, ScanContext, ScanResult } from '../core/types';
import { handlerFor } from '../formats';

export type DocStatus = 'reading' | 'scanning' | 'ready' | 'cleaning' | 'done' | 'error';

export interface CleanOutput {
  name: string;
  bytes: Uint8Array;
  removed: number;
  kept: number;
  /** Findings in the output that were not deliberately kept — should be 0. */
  residual: number;
  /** Raw-byte hits in the output (independent of the structured scanners). */
  raw: RawHit[];
  /** Raw hits are expected because something was kept (exceptions / manual items). */
  rawExpected: boolean;
  report: ReportFile;
}

export interface DocState {
  key: string;
  name: string;
  size: number;
  status: DocStatus;
  bytes?: Uint8Array;
  format?: FormatId;
  error?: string;
  result?: ScanResult;
  selected: Set<string>;
  output?: CleanOutput;
}

/** Let the browser paint (spinners, progress) before a long synchronous step. */
export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export type Patch = (key: string, patch: Partial<DocState>) => void;

export async function readAndScan(file: File, key: string, ctx: ScanContext, patch: Patch): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const det = detectFormat(file.name, bytes);
    if (!det.ok) return patch(key, { status: 'error', error: det.message, bytes });
    const handler = handlerFor(det.format);
    if (!handler) return patch(key, { status: 'error', format: det.format, bytes, error: '不支援的檔案格式。' });
    patch(key, { status: 'scanning', bytes, format: det.format });
    await scanBytes(key, bytes, det.format, { ...ctx, fileName: file.name }, patch);
  } catch (e) {
    patch(key, { status: 'error', error: errorMessage(e) });
  }
}

export async function scanBytes(key: string, bytes: Uint8Array, format: FormatId, ctx: ScanContext, patch: Patch): Promise<void> {
  try {
    await yieldToUi();
    const result = await handlerFor(format)!.scan(bytes, ctx);
    const selected = new Set(result.findings.filter((f) => f.removable && f.defaultSelected).map((f) => f.id));
    patch(key, { status: 'ready', result, selected, output: undefined, error: undefined });
  } catch (e) {
    patch(key, { status: 'error', error: errorMessage(e) });
  }
}

export async function cleanDoc(doc: DocState, baseCtx: ScanContext): Promise<CleanOutput> {
  const handler = handlerFor(doc.format!)!;
  const ctx = { ...baseCtx, fileName: doc.name }; // same context as the scan, so removals match what was shown
  await yieldToUi();
  const ids = new Set([...doc.selected].filter((id) => doc.result!.findings.some((f) => f.id === id && f.removable)));
  const bytes = await handler.apply(doc.bytes!, ctx, ids);
  // Verify: re-scan the output. Everything still found must be something the user chose to keep.
  const rescan = await handler.scan(bytes, ctx);
  const kept = doc.result!.findings.length - ids.size;
  const residual = Math.max(0, rescan.findings.length - kept);
  const raw = rawScan(doc.format!, bytes, compileRules(ctx.rules));
  const name = cleanFileName(doc.name);
  const findings = doc.result!.findings;
  const report: ReportFile = {
    file: doc.name,
    format: doc.format!,
    outputName: name,
    processedAt: new Date().toISOString(),
    sizeIn: doc.bytes!.length,
    sizeOut: bytes.length,
    sha256In: await sha256(doc.bytes!),
    sha256Out: await sha256(bytes),
    removed: findings.filter((f) => ids.has(f.id)),
    kept: findings.filter((f) => f.removable && !ids.has(f.id)),
    manual: findings.filter((f) => !f.removable),
    warnings: doc.result!.warnings,
    residual,
    rawResidual: raw.length,
  };
  return { name, bytes, removed: ids.size, kept, residual, raw, rawExpected: kept > 0, report };
}

export function download(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadZip(outputs: CleanOutput[]): void {
  const used = new Set<string>();
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const o of outputs) {
    let name = o.name;
    for (let i = 2; used.has(name); i++) name = o.name.replace(/(\.[^.]*)?$/, `(${i})$1`);
    used.add(name);
    files[name] = [o.bytes, { level: 0 }];
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  download(`EraserPanda_clean_${stamp}.zip`, zipSync(files), 'application/zip');
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return /[一-鿿]/.test(msg) ? msg : `處理失敗：${msg}`;
}
