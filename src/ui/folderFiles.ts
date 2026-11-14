/** File types the tool can process (by extension) — used when walking folders. */
export const SUPPORTED_EXT = /\.(pdf|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm|txt|csv|tsv|md)$/i;

/**
 * Files to skip when they come from a folder: Office lock files (~$report.docx, a few bytes of owner name),
 * hidden / system files, and anything we cannot process.
 */
export function wantedFromFolder(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (base.startsWith('~$') || base.startsWith('.') || base === 'Thumbs.db' || base === 'desktop.ini') return false;
  return SUPPORTED_EXT.test(base);
}

/** Minimal shape of the (non-standard but universally supported) FileSystem Entry API. */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void };
}

/**
 * Expand dropped items: plain files pass through, folders are walked recursively (readEntries returns batches,
 * so it is called until it returns nothing). Must be given the entries obtained synchronously in the drop event.
 */
export async function filesFromEntries(entries: Entry[], depth = 0): Promise<{ files: File[]; skipped: number }> {
  const files: File[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.isFile && entry.file) {
      const f = await new Promise<File | null>((ok) => entry.file!(ok, () => ok(null)));
      if (!f) continue;
      if (depth === 0 || wantedFromFolder(f.name)) files.push(f);
      else skipped++;
    } else if (entry.isDirectory && entry.createReader && depth < 16) {
      const reader = entry.createReader();
      const children: Entry[] = [];
      for (;;) {
        const batch = await new Promise<Entry[]>((ok) => reader.readEntries(ok, () => ok([])));
        if (!batch.length) break;
        children.push(...batch);
      }
      const sub = await filesFromEntries(children, depth + 1);
      files.push(...sub.files);
      skipped += sub.skipped;
    }
  }
  return { files, skipped };
}

export type { Entry as FsEntry };
