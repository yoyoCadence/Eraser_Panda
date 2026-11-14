import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildRules, loadSettings, saveSettings, type Settings } from '../core/settings';
import { reportCsv, reportJson } from '../core/report';
import type { ScanContext } from '../core/types';
import { DropZone } from './DropZone';
import { cleanDoc, download, downloadZip, readAndScan, scanBytes, type DocState } from './engine';
import { FindingsPanel } from './FindingsPanel';
import { browserDecode } from './imageDecode';
import { SettingsDialog } from './SettingsDialog';

let seq = 0;
const ACK_KEY = 'eraser-panda:ack:v1';

const STATUS_LABEL: Record<DocState['status'], string> = {
  reading: '讀取中…',
  scanning: '掃描中…',
  ready: '',
  cleaning: '清除中…',
  done: '已清除',
  error: '無法處理',
};

export function App() {
  const [docs, setDocs] = useState<DocState[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | (() => void)>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [dontAsk, setDontAsk] = useState(false);
  useEffect(() => {
    const d = confirmRef.current;
    if (!d) return;
    if (confirm && !d.open) d.showModal();
    if (!confirm && d.open) d.close();
  }, [confirm]);
  /** One-time reminder that the tool does not decide whether a document may be shared. */
  const guarded = (action: () => void) => {
    let acknowledged = false;
    try {
      acknowledged = localStorage.getItem(ACK_KEY) === '1';
    } catch {
      acknowledged = false;
    }
    if (acknowledged) action();
    else setConfirm(() => action);
  };
  const scanCtx = useMemo<ScanContext>(() => ({ rules: buildRules(settings), logoHashes: settings.logoSamples.map((l) => l.hash), decodeImage: browserDecode }), [settings]);
  const ctxRef = useRef(scanCtx);
  ctxRef.current = scanCtx;
  const docsRef = useRef(docs);
  docsRef.current = docs;

  const patch = useCallback((key: string, p: Partial<DocState>) => {
    setDocs((list) => list.map((d) => (d.key === key ? { ...d, ...p } : d)));
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const added: DocState[] = files.map((f) => ({ key: `d${++seq}`, name: f.name, size: f.size, status: 'reading', selected: new Set() }));
      setDocs((list) => [...list, ...added]);
      setActiveKey((k) => k ?? added[0]?.key ?? null);
      for (let i = 0; i < files.length; i++) await readAndScan(files[i]!, added[i]!.key, ctxRef.current, patch);
    },
    [patch],
  );

  // Rules changed → re-scan every document that was scanned before.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    (async () => {
      for (const d of docsRef.current) {
        if (d.bytes && d.format && (d.status === 'ready' || d.status === 'done')) {
          patch(d.key, { status: 'scanning' });
          await scanBytes(d.key, d.bytes, d.format, { ...scanCtx, fileName: d.name }, patch, { result: d.result, selected: d.selected });
        }
      }
    })();
  }, [scanCtx, patch]);

  const clean = useCallback(
    async (key: string, autoDownload = true) => {
      const doc = docsRef.current.find((d) => d.key === key);
      if (!doc || !doc.result) return undefined;
      patch(key, { status: 'cleaning', cleanError: undefined });
      try {
        const output = await cleanDoc(doc, ctxRef.current);
        patch(key, { status: 'done', output });
        if (autoDownload) download(output.name, output.bytes);
        return output;
      } catch (e) {
        // keep the scan result so the user can change the selection and retry
        patch(key, { status: 'ready', cleanError: `清除失敗：${(e as Error).message}` });
        return undefined;
      }
    },
    [patch],
  );

  const cleanAll = useCallback(async () => {
    const targets = docsRef.current.filter((d) => (d.status === 'ready' || d.status === 'done') && d.result);
    const outputs = [];
    for (const d of targets) {
      const o = await clean(d.key, false);
      if (o) outputs.push(o);
    }
    if (outputs.length === 1) download(outputs[0]!.name, outputs[0]!.bytes);
    else if (outputs.length > 1) downloadZip(outputs);
  }, [clean]);

  const remove = (key: string) => {
    setDocs((list) => list.filter((d) => d.key !== key));
    if (activeKey === key) setActiveKey(docs.find((d) => d.key !== key)?.key ?? null);
  };

  const reports = docs.filter((d) => d.output).map((d) => d.output!.report);
  const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const active = docs.find((d) => d.key === activeKey) ?? null;
  const cleanable = docs.filter((d) => (d.status === 'ready' || d.status === 'done') && d.result && d.result.findings.length > 0);

  return (
    <div class="app">
      <header class="topbar">
        <h1>
          <span aria-hidden="true">🐼</span> Eraser Panda
        </h1>
        <span class="tagline">文件分級標籤 / Logo / 敏感度 metadata 一鍵清除</span>
        <button type="button" class="ghost" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
          ⚙️ 關鍵字設定
        </button>
        <span class="badge-local" title="所有處理都在瀏覽器內完成，頁面已以 CSP 封鎖所有網路連線">
          🔒 100% 本機處理・不連網
        </span>
      </header>

      {docs.length === 0 ? (
        <main class="landing">
          <DropZone onFiles={addFiles} />
          <ol class="steps">
            <li>
              <b>拖曳文件</b>：PDF、Word、Excel、PowerPoint、TXT / CSV，可一次多個
            </li>
            <li>
              <b>檢視發現</b>：Confidential、機密等字眼、浮水印、敏感度標籤 metadata、作者 / 公司資訊
            </li>
            <li>
              <b>標記例外</b>：取消勾選要保留的項目
            </li>
            <li>
              <b>一鍵清除</b>：下載 <code>原檔名_clean</code>，原始檔案不會被修改
            </li>
          </ol>
          <p class="disclaimer">本工具不判斷文件是否可以外傳 —— 請只在已確認可外傳的前提下使用，並保留處理紀錄。</p>
        </main>
      ) : (
        <main class="workspace">
          <aside class="sidebar">
            <DropZone onFiles={addFiles} compact />
            <ul class="filelist" data-testid="file-list">
              {docs.map((d) => (
                <li key={d.key} class={`${d.key === activeKey ? 'active' : ''} ${d.status}`}>
                  <button type="button" class="file-btn" onClick={() => setActiveKey(d.key)}>
                    <span class="fname">{d.name}</span>
                    <span class="fstat">
                      {d.status === 'ready' || d.status === 'done' ? (
                        <>
                          {d.status === 'done' && (d.output?.residual ? '⚠️ ' : '✅ ')}
                          {d.result?.findings.length ?? 0} 項
                        </>
                      ) : (
                        STATUS_LABEL[d.status]
                      )}
                    </span>
                  </button>
                  <button type="button" class="file-x" aria-label={`移除 ${d.name}`} onClick={() => remove(d.key)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {cleanable.length > 1 && (
              <button type="button" class="primary block" onClick={() => guarded(cleanAll)} data-testid="clean-all">
                🧹 全部清除並下載 ZIP（{cleanable.length} 個檔案）
              </button>
            )}
            {reports.length > 0 && (
              <div class="report-box">
                <span class="muted small">處理報告（稽核紀錄，只含標籤字眼與位置）</span>
                <div class="report-actions">
                  <button type="button" onClick={() => download(`EraserPanda_report_${stamp()}.csv`, new TextEncoder().encode(reportCsv(reports)), 'text/csv')} data-testid="report-csv">
                    📄 CSV
                  </button>
                  <button type="button" onClick={() => download(`EraserPanda_report_${stamp()}.json`, new TextEncoder().encode(reportJson(reports)), 'application/json')}>
                    🧾 JSON
                  </button>
                </div>
              </div>
            )}
          </aside>
          <div class="content">
            {!active ? null : active.status === 'error' ? (
              <section class="panel">
                <h2>{active.name}</h2>
                <p class="error" data-testid="doc-error">
                  {active.error}
                </p>
              </section>
            ) : active.status === 'reading' || active.status === 'scanning' ? (
              <section class="panel loading">
                <div class="spinner" aria-hidden="true" />
                <p>{STATUS_LABEL[active.status]}</p>
              </section>
            ) : (
              <FindingsPanel
                doc={active}
                onSelect={(ids) => patch(active.key, { selected: ids, output: undefined, status: 'ready' })}
                onClean={() => guarded(() => void clean(active.key))}
                onDownloadAgain={() => active.output && download(active.output.name, active.output.bytes)}
              />
            )}
          </div>
        </main>
      )}

      <dialog
        ref={confirmRef}
        class="settings confirm"
        onClose={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
        data-testid="confirm-dialog"
      >
        <form method="dialog" onSubmit={(e) => e.preventDefault()}>
          <h2>開始清除前請確認</h2>
          <p>本工具只移除分級標籤、Logo 與敏感度 metadata，<b>不會判斷文件是否可以外傳</b>。</p>
          <p>請確認這些文件的內容已經過授權，可以分享到外部或上傳到 AI 服務。處理後可下載報告作為稽核紀錄。</p>
          <label class="small">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.currentTarget.checked)} /> 我了解，之後不再提醒
          </label>
          <div class="dialog-actions">
            <button type="button" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              type="button"
              class="primary"
              data-testid="confirm-ok"
              onClick={() => {
                if (dontAsk) {
                  try {
                    localStorage.setItem(ACK_KEY, '1');
                  } catch {
                    /* storage unavailable — ask again next time */
                  }
                }
                const action = confirm;
                setConfirm(null);
                action?.();
              }}
            >
              已確認，開始清除
            </button>
          </div>
        </form>
      </dialog>

      <footer class="appfoot">
        Eraser Panda v{__APP_VERSION__}・所有處理都在你的瀏覽器內完成，頁面不會連上網路・
        <a href="https://github.com/yoyoCadence/Eraser_Panda" target="_blank" rel="noopener noreferrer">
          原始碼
        </a>
      </footer>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(s) => {
          saveSettings(s);
          setSettings(s);
          setSettingsOpen(false);
        }}
      />
    </div>
  );
}
