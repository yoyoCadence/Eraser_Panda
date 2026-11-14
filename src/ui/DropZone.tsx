import { useEffect, useRef, useState } from 'preact/hooks';
import { filesFromEntries, wantedFromFolder, type FsEntry } from './folderFiles';

interface Props {
  onFiles: (files: File[]) => void;
  /** a folder contained files that were not added (unsupported types, Office lock files …) */
  onSkipped?: (count: number) => void;
  compact?: boolean;
}

/**
 * Accepts files dropped anywhere on the window (not only on the box) and via a file picker.
 * Dropping on the window must be intercepted, otherwise the browser navigates away and opens the document.
 */
export function DropZone({ onFiles, onSkipped, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      // Entries must be taken synchronously — the DataTransfer is emptied once this handler returns.
      const entries = Array.from(e.dataTransfer?.items ?? [])
        .map((it) => (it.kind === 'file' ? (it.webkitGetAsEntry?.() as unknown as FsEntry | null) : null))
        .filter((x): x is FsEntry => !!x);
      if (entries.some((x) => x.isDirectory)) {
        void filesFromEntries(entries).then(({ files, skipped }) => {
          if (files.length) onFiles(files);
          if (skipped) onSkipped?.(skipped);
        });
        return;
      }
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [onFiles, onSkipped]);

  return (
    <>
      <button
        type="button"
        class={`dropzone${compact ? ' compact' : ''}${over ? ' over' : ''}`}
        onClick={() => input.current?.click()}
        data-testid="dropzone"
      >
        <span class="dz-icon" aria-hidden="true">🐼</span>
        <span class="dz-title">{compact ? '加入更多檔案' : '把文件拖曳到這裡'}</span>
        {!compact && <span class="dz-sub">或點擊選擇檔案・也可以拖曳整個資料夾・支援 PDF、Word、Excel、PowerPoint、TXT/CSV</span>}
      </button>
      {!compact && (
        <button type="button" class="link folder-link" onClick={() => folderInput.current?.click()} data-testid="pick-folder">
          📁 選擇整個資料夾
        </button>
      )}
      <input
        ref={folderInput}
        type="file"
        hidden
        // @ts-expect-error non-standard but supported by Chromium, Firefox and Safari
        webkitdirectory={true}
        data-testid="folder-input"
        onChange={(e) => {
          const el = e.currentTarget;
          const all = Array.from(el.files ?? []);
          el.value = '';
          const files = all.filter((f) => wantedFromFolder(f.webkitRelativePath || f.name));
          if (files.length) onFiles(files);
          if (all.length - files.length) onSkipped?.(all.length - files.length);
        }}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.docm,.xlsx,.xlsm,.pptx,.pptm,.txt,.csv,.tsv,.md"
        data-testid="file-input"
        onChange={(e) => {
          const el = e.currentTarget;
          const files = Array.from(el.files ?? []);
          el.value = '';
          if (files.length) onFiles(files);
        }}
      />
      {over && <div class="drop-overlay" aria-hidden="true">放開以加入檔案</div>}
    </>
  );
}
