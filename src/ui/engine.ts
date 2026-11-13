import { zipSync } from 'fflate';
import { cleanFileName, detectFormat } from '../core/fileType';
import type { FormatId, Rule, ScanResult } from '../core/types';
import { handlerFor } from '../formats';

export type DocStatus = 'reading' | 'scanning' | 'ready' | 'cleaning' | 'done' | 'error';

export interface CleanOutput {
  name: string;
  bytes: Uint8Array;
  removed: number;
  kept: number;
  /** Findings in the output that were not deliberately kept — should be 0. */
  residual: number;
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

export async function readAndScan(file: File, key: string, rules: Rule[], patch: Patch): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const det = detectFormat(file.name, bytes);
    if (!det.ok) return patch(key, { status: 'error', error: det.message, bytes });
    const handler = handlerFor(det.format);
    if (!handler) return patch(key, { status: 'error', format: det.format, bytes, error: 'PDF 支援正在開發中，下一版即可使用。' });
    patch(key, { status: 'scanning', bytes, format: det.format });
    await scanBytes(key, bytes, det.format, rules, patch);
  } catch (e) {
    patch(key, { status: 'error', error: errorMessage(e) });
  }
}

export async function scanBytes(key: string, bytes: Uint8Array, format: FormatId, rules: Rule[], patch: Patch): Promise<void> {
  try {
    await yieldToUi();
    const result = await handlerFor(format)!.scan(bytes, { rules });
    const selected = new Set(result.findings.filter((f) => f.removable && f.defaultSelected).map((f) => f.id));
    patch(key, { status: 'ready', result, selected, output: undefined, error: undefined });
  } catch (e) {
    patch(key, { status: 'error', error: errorMessage(e) });
  }
}

export async function cleanDoc(doc: DocState, rules: Rule[]): Promise<CleanOutput> {
  const handler = handlerFor(doc.format!)!;
  await yieldToUi();
  const ids = new Set([...doc.selected].filter((id) => doc.result!.findings.some((f) => f.id === id && f.removable)));
  const bytes = await handler.apply(doc.bytes!, { rules }, ids);
  // Verify: re-scan the output. Everything still found must be something the user chose to keep.
  const rescan = await handler.scan(bytes, { rules });
  const kept = doc.result!.findings.length - ids.size;
  const residual = Math.max(0, rescan.findings.length - kept);
  return { name: cleanFileName(doc.name), bytes, removed: ids.size, kept, residual };
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
