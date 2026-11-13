import { useMemo, useState } from 'preact/hooks';
import type { Finding, LocationKind } from '../core/types';
import type { DocState } from './engine';

interface Group {
  key: string;
  label: string;
  hint?: string;
  test: (f: Finding) => boolean;
}

const OTHER: LocationKind[] = ['textbox', 'chart', 'formula', 'comment', 'notes', 'annotation', 'bookmark', 'formField', 'other'];

const GROUPS: Group[] = [
  { key: 'label', label: '敏感度標籤 / 分級屬性', hint: 'DLP 最常見的觸發來源（隱藏在檔案 metadata）', test: (f) => f.removable && f.location === 'label' },
  { key: 'watermark', label: '浮水印', test: (f) => f.removable && f.location === 'watermark' },
  { key: 'hf', label: '頁首 / 頁尾 / 母片', test: (f) => f.removable && ['header', 'footer', 'master'].includes(f.location) },
  { key: 'body', label: '內文', hint: '刪除內文語句中的字眼可能改變語意，請確認', test: (f) => f.removable && f.location === 'body' },
  { key: 'other', label: '文字方塊 / 圖表 / 公式 / 註解 / 備忘稿', test: (f) => f.removable && OTHER.includes(f.location) },
  { key: 'property', label: '文件屬性 / 身分資訊 / 縮圖', test: (f) => f.removable && f.location === 'property' },
  { key: 'report', label: '僅提示（無法自動處理）', hint: '請在原始軟體中手動修改', test: (f) => !f.removable },
];

const FORMAT_LABEL = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', pdf: 'PDF', text: '純文字' } as const;

interface Props {
  doc: DocState;
  onSelect: (ids: Set<string>) => void;
  onClean: () => void;
  onDownloadAgain: () => void;
}

export function FindingsPanel({ doc, onSelect, onClean, onDownloadAgain }: Props) {
  const findings = doc.result?.findings ?? [];
  const [filter, setFilter] = useState('');
  const removable = useMemo(() => findings.filter((f) => f.removable), [findings]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? findings.filter((f) => `${f.matchText} ${f.where}`.toLowerCase().includes(q)) : findings;
  }, [findings, filter]);

  const sel = doc.selected;
  const set = (ids: Iterable<string>, on: boolean) => {
    const next = new Set(sel);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    onSelect(next);
  };
  const proseIds = removable.filter((f) => f.location === 'body' && f.confidence !== 'high').map((f) => f.id);
  const busy = doc.status === 'cleaning';
  const selectedCount = removable.filter((f) => sel.has(f.id)).length;

  return (
    <section class="panel" data-testid="findings-panel">
      <header class="panel-head">
        <div class="panel-title">
          <h2>{doc.name}</h2>
          <span class="muted">
            {doc.format ? FORMAT_LABEL[doc.format] : ''}
            {doc.result?.pageCount ? `・${doc.result.pageCount} ${doc.format === 'xlsx' ? '個工作表' : doc.format === 'pptx' ? '張投影片' : '頁'}` : ''}
            ・{findings.length} 項發現
          </span>
        </div>
        {doc.result?.warnings.map((w) => (
          <p class="warn" key={w}>
            ⚠️ {w}
          </p>
        ))}
      </header>

      {findings.length === 0 ? (
        <div class="empty-ok" data-testid="no-findings">
          <span aria-hidden="true">✅</span>
          <p>沒有找到任何標籤字眼或敏感度 metadata。</p>
          <p class="muted">若預期應該有，請到「關鍵字設定」新增公司名稱或專案代號。</p>
        </div>
      ) : (
        <>
          <div class="actionbar">
            <button type="button" class="primary" disabled={busy || selectedCount === 0} onClick={onClean} data-testid="clean-one">
              {busy ? '處理中…' : `🧹 清除 ${selectedCount} 項並下載`}
            </button>
            <button type="button" onClick={() => set(removable.map((f) => f.id), true)} disabled={busy}>
              全選
            </button>
            <button type="button" onClick={() => set(removable.map((f) => f.id), false)} disabled={busy}>
              全不選
            </button>
            {proseIds.length > 0 && (
              <button type="button" onClick={() => set(proseIds, false)} disabled={busy} title="把出現在一般句子中的字眼都標為例外（保留）">
                保留內文語句（{proseIds.length}）
              </button>
            )}
            <input class="filter" type="search" placeholder="篩選…" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="篩選發現項目" />
          </div>

          {doc.output && (
            <div class={`result ${doc.output.residual ? 'bad' : 'good'}`} data-testid="clean-result">
              <span>
                {doc.output.residual === 0 ? '✅' : '⚠️'} 已產生 <b>{doc.output.name}</b>：移除 {doc.output.removed} 項
                {doc.output.kept > 0 && `、保留例外 ${doc.output.kept} 項`}・驗證殘留 <b>{doc.output.residual}</b>
              </span>
              <button type="button" class="link" onClick={onDownloadAgain}>
                再次下載
              </button>
            </div>
          )}

          <div class="groups">
            {GROUPS.map((g) => {
              const items = shown.filter(g.test);
              if (!items.length) return null;
              const ids = items.filter((f) => f.removable).map((f) => f.id);
              const on = ids.filter((id) => sel.has(id)).length;
              return (
                <details class="group" open key={g.key} data-group={g.key}>
                  <summary>
                    {ids.length > 0 && (
                      <input
                        type="checkbox"
                        checked={on === ids.length}
                        indeterminate={on > 0 && on < ids.length}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => set(ids, e.currentTarget.checked)}
                        aria-label={`全選：${g.label}`}
                        disabled={busy}
                      />
                    )}
                    <span class="group-label">{g.label}</span>
                    <span class="count">{ids.length ? `${on}/${ids.length}` : items.length}</span>
                    {g.hint && <span class="group-hint">{g.hint}</span>}
                  </summary>
                  <ul class="findings">
                    {items.map((f) => (
                      <FindingRow key={f.id} f={f} checked={sel.has(f.id)} disabled={busy} onToggle={(v) => set([f.id], v)} />
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function FindingRow({ f, checked, disabled, onToggle }: { f: Finding; checked: boolean; disabled: boolean; onToggle: (v: boolean) => void }) {
  const ctx = f.context ?? { before: '', match: f.matchText, after: '' };
  return (
    <li class={`finding${f.removable ? '' : ' report'}${f.removable && !checked ? ' kept' : ''}`} data-finding-id={f.id}>
      <label>
        {f.removable ? <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onToggle(e.currentTarget.checked)} /> : <span class="nocheck">ℹ️</span>}
        <span class="snippet">
          <span class="ctx">{ctx.before}</span>
          <mark>{ctx.match}</mark>
          <span class="ctx">{ctx.after}</span>
        </span>
        <span class="where">{f.where}</span>
      </label>
      {(f.note || (f.removable && !checked)) && (
        <p class="note">
          {f.removable && !checked && <span class="tag keep">例外・保留</span>}
          {f.confidence === 'high' && f.removable && <span class="tag high">高信心</span>}
          {f.note}
        </p>
      )}
    </li>
  );
}
