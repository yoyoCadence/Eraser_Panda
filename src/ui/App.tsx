import { useCallback, useState } from 'preact/hooks';
import { detectFormat } from '../core/fileType';
import type { FormatId } from '../core/types';
import { DropZone } from './DropZone';

interface Doc {
  key: string;
  name: string;
  size: number;
  format?: FormatId;
  error?: string;
}

const FORMAT_LABEL: Record<FormatId, string> = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', pdf: 'PDF', text: '純文字' };

let seq = 0;

export function App() {
  const [docs, setDocs] = useState<Doc[]>([]);

  const addFiles = useCallback(async (files: File[]) => {
    const added: Doc[] = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const det = detectFormat(f.name, bytes);
      added.push({ key: `${++seq}`, name: f.name, size: f.size, ...(det.ok ? { format: det.format } : { error: det.message }) });
    }
    setDocs((d) => [...d, ...added]);
  }, []);

  return (
    <div class="app">
      <header class="topbar">
        <h1>
          <span aria-hidden="true">🐼</span> Eraser Panda
        </h1>
        <span class="badge-local" title="所有處理都在瀏覽器內完成，頁面已以 CSP 封鎖所有網路連線">🔒 100% 本機處理・不連網</span>
      </header>
      <main>
        <DropZone onFiles={addFiles} compact={docs.length > 0} />
        {docs.length > 0 && (
          <ul class="filelist" data-testid="file-list">
            {docs.map((d) => (
              <li key={d.key} class={d.error ? 'err' : ''}>
                <span class="fname">{d.name}</span>
                <span class="fmeta">{d.format ? FORMAT_LABEL[d.format] : '無法處理'}・{(d.size / 1024).toFixed(1)} KB</span>
                {d.error && <p class="ferr">{d.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
