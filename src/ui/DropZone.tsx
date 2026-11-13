import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

/**
 * Accepts files dropped anywhere on the window (not only on the box) and via a file picker.
 * Dropping on the window must be intercepted, otherwise the browser navigates away and opens the document.
 */
export function DropZone({ onFiles, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
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
  }, [onFiles]);

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
        {!compact && <span class="dz-sub">或點擊選擇檔案・支援 PDF、Word、Excel、PowerPoint、TXT/CSV</span>}
      </button>
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
