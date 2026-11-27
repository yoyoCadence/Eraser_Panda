import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Finding, LocationKind, NormRect, Region, RegionStats } from '../core/types';
import { rangeLabel, regionSummary, regionWarnings } from '../formats/pdf/regions';
import type { DocState } from './engine';
import { PdfPreview, type RegionState } from './PdfPreview';
import { TextPreview } from './TextPreview';

let regionSeq = 0;

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
  { key: 'logo', label: 'Logo / 圖片', hint: '依「跨頁重複」「頁首頁尾 / 母片」「符合 Logo 樣本」判斷', test: (f) => f.removable && f.kind === 'image' && f.location !== 'property' && f.location !== 'watermark' },
  { key: 'hf', label: '頁首 / 頁尾 / 母片', test: (f) => f.removable && f.kind !== 'image' && ['header', 'footer', 'master'].includes(f.location) },
  { key: 'body', label: '內文', hint: '刪除內文語句中的字眼可能改變語意，請確認', test: (f) => f.removable && f.kind !== 'image' && f.location === 'body' },
  { key: 'other', label: '文字方塊 / 圖表 / 公式 / 註解 / 備忘稿', test: (f) => f.removable && f.kind !== 'image' && OTHER.includes(f.location) },
  { key: 'property', label: '文件屬性 / 身分資訊 / 縮圖', test: (f) => f.removable && f.location === 'property' },
  { key: 'report', label: '僅提示（無法自動處理）', hint: '請在原始軟體中手動修改', test: (f) => !f.removable },
];

const FORMAT_LABEL = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', pdf: 'PDF', text: '純文字' } as const;

interface Props {
  doc: DocState;
  onSelect: (ids: Set<string>) => void;
  onRegions: (regions: Region[]) => void;
  onClean: () => void;
  onDownloadAgain: () => void;
}

interface Pending {
  page: number;
  rect: NormRect;
  from: number;
  to: number;
}

export function FindingsPanel({ doc, onSelect, onRegions, onClean, onDownloadAgain }: Props) {
  const findings = doc.result?.findings ?? [];
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState<{ id: string | null; tick: number }>({ id: null, tick: 0 });
  const [viewChoice, setView] = useState<'original' | 'clean'>('original');
  // "cleaned" only exists once this document has an output (the panel is reused across documents)
  const view = doc.output ? viewChoice : 'original';
  const locate = (id: string) => setFocus((f) => ({ id, tick: f.tick + 1 }));
  const isPdf = doc.format === 'pdf' && !!doc.bytes;
  const blocks = doc.result?.preview ?? [];
  const hasPreview = isPdf || blocks.length > 0;
  const previewIds = useMemo(() => new Set(blocks.flatMap((b) => b.lines.flatMap((l) => l.marks.map((m) => m.id)))), [blocks]);
  const previewBytes = view === 'clean' && doc.output ? doc.output.bytes : doc.bytes;
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

  // ---- user-drawn removal regions (PDF) ----
  const pageCount = doc.result?.pageCount ?? 1;
  const [drawing, setDrawing] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    // switching documents ends any drawing in progress and starts on the original
    setDrawing(false);
    setPending(null);
    setView('original');
  }, [doc.key]);
  useEffect(() => {
    if (!drawing && !pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawing(false);
      setPending(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, pending]);
  const regionIds = new Set(findings.filter((f) => f.kind === 'region').map((f) => f.id));
  const regionState = (r: Region): RegionState => (!regionIds.has(`region:${r.id}`) ? 'empty' : sel.has(`region:${r.id}`) ? 'on' : 'off');
  const clampPage = (n: number) => Math.min(pageCount, Math.max(1, Math.round(n) || 1));
  const addPending = () => {
    if (!pending) return;
    const from = clampPage(Math.min(pending.from, pending.to));
    const to = clampPage(Math.max(pending.from, pending.to));
    onRegions([...doc.regions, { id: `r${++regionSeq}`, rect: pending.rect, from, to }]);
    setPending(null);
  };
  const updateRegion = (id: string, p: Partial<Region>) =>
    onRegions(
      doc.regions.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...p };
        return { ...next, from: clampPage(Math.min(next.from, next.to)), to: clampPage(Math.max(next.from, next.to)) };
      }),
    );
  const showRegions = isPdf && view === 'original';

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

      {findings.length === 0 && !isPdf ? (
        <NoFindings />
      ) : (
        <>
          <div class="actionbar">
            <button type="button" class="primary" disabled={busy || !!doc.rescanning || selectedCount === 0} onClick={onClean} data-testid="clean-one">
              {busy ? (
                <>
                  <span class="btn-spinner" aria-hidden="true" /> 清除中…
                </>
              ) : (
                `🧹 清除 ${selectedCount} 項並下載`
              )}
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

          {doc.cleanError && (
            <p class="warn" data-testid="clean-error">
              ⚠️ {doc.cleanError}
            </p>
          )}
          {doc.output && <CleanResult output={doc.output} onDownloadAgain={onDownloadAgain} />}

          <div class={hasPreview ? 'split' : ''}>
          <div class="groups">
            {findings.length === 0 && <NoFindings pdf />}
            {isPdf && doc.regions.length > 0 && (
              <details class="group" open data-group="region">
                <summary>
                  <span class="group-label">✂️ 手動框選區域</span>
                  <span class="count">{doc.regions.length}</span>
                  <span class="group-hint">框內的文字、圖片、向量圖形與註解會被真正刪除（不是蓋住）；可調整頁面範圍</span>
                </summary>
                <ul class="findings">
                  {doc.regions.map((r, idx) => (
                    <RegionRow
                      key={r.id}
                      index={idx + 1}
                      region={r}
                      pageCount={pageCount}
                      stats={doc.result?.regionStats?.[r.id]}
                      finding={regionIds.has(`region:${r.id}`)}
                      checked={sel.has(`region:${r.id}`)}
                      disabled={busy}
                      updating={!!doc.rescanning}
                      focused={focus.id === `region:${r.id}`}
                      onToggle={(v) => set([`region:${r.id}`], v)}
                      onRange={(from, to) => updateRegion(r.id, { from, to })}
                      onLocate={() => (setView('original'), locate(`region:${r.id}`))}
                      onDelete={() => onRegions(doc.regions.filter((x) => x.id !== r.id))}
                    />
                  ))}
                </ul>
              </details>
            )}
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
                      <FindingRow
                        key={f.id}
                        f={f}
                        checked={sel.has(f.id)}
                        disabled={busy}
                        focused={focus.id === f.id}
                        onToggle={(v) => set([f.id], v)}
                        onLocate={(isPdf && f.page) || previewIds.has(f.id) ? () => (setView('original'), locate(f.id)) : undefined}
                      />
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
          {hasPreview && (
            <aside class="preview-col">
              <div class="preview-head">
                <span class="muted">
                  預覽
                  {doc.rescanning && (
                    <span class="updating" data-testid="rescanning">
                      <span class="btn-spinner dark" aria-hidden="true" /> 更新框選區域…
                    </span>
                  )}
                </span>
                {isPdf && (
                  <button
                    type="button"
                    class={`draw-toggle${drawing ? ' on' : ''}`}
                    aria-pressed={drawing}
                    disabled={busy}
                    onClick={() => {
                      setView('original');
                      setPending(null);
                      setDrawing((d) => !d);
                    }}
                    data-testid="draw-toggle"
                  >
                    {drawing ? '✕ 取消框選' : '✂️ 框選要移除的區域'}
                  </button>
                )}
                {isPdf && doc.output && (
                  <div class="seg" role="tablist">
                    <button type="button" role="tab" aria-selected={view === 'original'} class={view === 'original' ? 'on' : ''} onClick={() => setView('original')}>
                      原始
                    </button>
                    <button type="button" role="tab" aria-selected={view === 'clean'} class={view === 'clean' ? 'on' : ''} onClick={() => setView('clean')} data-testid="view-clean">
                      清除後
                    </button>
                  </div>
                )}
              </div>
              {isPdf && drawing && !pending && <p class="draw-hint">在任一頁上<b>按住拖曳</b>，框出要移除的範圍（Esc 取消）</p>}
              {isPdf && pending && (
                <form
                  class="pending-bar"
                  data-testid="pending-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addPending();
                  }}
                >
                  <span>
                    套用到 第{' '}
                    <input type="number" min={1} max={pageCount} value={pending.from} onInput={(e) => setPending({ ...pending, from: Number(e.currentTarget.value) })} aria-label="起始頁" data-testid="pending-from" /> 頁 到 第{' '}
                    <input type="number" min={1} max={pageCount} value={pending.to} onInput={(e) => setPending({ ...pending, to: Number(e.currentTarget.value) })} aria-label="結束頁" data-testid="pending-to" /> 頁
                    <span class="muted small">（共 {pageCount} 頁）</span>
                  </span>
                  <span class="pending-quick">
                    <button type="button" onClick={() => setPending({ ...pending, from: pending.page, to: pending.page })}>
                      只有第 {pending.page} 頁
                    </button>
                    <button type="button" onClick={() => setPending({ ...pending, from: pending.page, to: pageCount })}>
                      到最後一頁
                    </button>
                    <button type="button" onClick={() => setPending({ ...pending, from: 1, to: pageCount })} data-testid="pending-all">
                      全部頁面
                    </button>
                  </span>
                  <span class="pending-actions">
                    <button type="button" onClick={() => setPending(null)}>
                      取消
                    </button>
                    <button type="submit" class="primary" data-testid="pending-add">
                      ✂️ 加入區域
                    </button>
                  </span>
                </form>
              )}
              {isPdf ? (
              <PdfPreview
                bytes={previewBytes!}
                findings={view === 'original' ? findings : []}
                selected={sel}
                focusId={view === 'original' ? focus.id : null}
                focusTick={focus.tick}
                onPick={(id) => {
                  locate(id);
                  document.querySelector(`[data-finding-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
                regions={showRegions ? doc.regions : []}
                regionState={regionState}
                drawing={drawing && showRegions}
                pending={showRegions ? pending : null}
                onDrawn={(page, rect) => {
                  setDrawing(false);
                  setPending({ page, rect, from: page, to: page });
                }}
              />
              ) : (
                <TextPreview
                  blocks={blocks}
                  selected={sel}
                  focusId={focus.id}
                  focusTick={focus.tick}
                  onPick={(id) => {
                    locate(id);
                    document.querySelector(`[data-finding-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                />
              )}
            </aside>
          )}
          </div>
        </>
      )}
    </section>
  );
}

function NoFindings({ pdf }: { pdf?: boolean }) {
  return (
    <div class={`empty-ok${pdf ? ' compact' : ''}`} data-testid="no-findings">
      <span aria-hidden="true">✅</span>
      <p>沒有找到任何標籤字眼或敏感度 metadata。</p>
      <p class="muted">
        若預期應該有，請到「關鍵字設定」新增公司名稱或專案代號
        {pdf ? '；或在右側預覽按「✂️ 框選要移除的區域」，直接框出要刪除的位置。' : '。'}
      </p>
    </div>
  );
}

interface RegionRowProps {
  index: number;
  region: Region;
  pageCount: number;
  stats?: RegionStats;
  /** the region contains something removable (it has a finding) */
  finding: boolean;
  checked: boolean;
  disabled: boolean;
  updating: boolean;
  focused: boolean;
  onToggle: (v: boolean) => void;
  onRange: (from: number, to: number) => void;
  onLocate: () => void;
  onDelete: () => void;
}

function RegionRow({ index, region, pageCount, stats, finding, checked, disabled, updating, focused, onToggle, onRange, onLocate, onDelete }: RegionRowProps) {
  const warnings = stats ? regionWarnings(stats) : [];
  return (
    <li class={`finding region-row${finding && !checked ? ' kept' : ''}${focused ? ' focused' : ''}`} data-finding-id={`region:${region.id}`} data-testid="region-row">
      <div class="region-line">
        {finding ? (
          <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onToggle(e.currentTarget.checked)} aria-label={`框選區域 ${index}`} />
        ) : (
          <span class="nocheck">ℹ️</span>
        )}
        <b>區域 {index}</b>
        <span class="region-range">
          第{' '}
          <input type="number" min={1} max={pageCount} value={region.from} disabled={disabled} onChange={(e) => onRange(Number(e.currentTarget.value), region.to)} aria-label={`區域 ${index} 起始頁`} />
          –
          <input type="number" min={1} max={pageCount} value={region.to} disabled={disabled} onChange={(e) => onRange(region.from, Number(e.currentTarget.value))} aria-label={`區域 ${index} 結束頁`} /> 頁
        </span>
        <button type="button" class="locate" onClick={onLocate} title={`在預覽中顯示位置（${rangeLabel(region)}）`}>
          📍 定位
        </button>
        <button type="button" class="icon-btn" onClick={onDelete} disabled={disabled} aria-label={`刪除區域 ${index}`} title="刪除這個區域">
          🗑
        </button>
      </div>
      <p class="note">
        {updating || !stats ? (
          <span class="muted">計算中…</span>
        ) : (
          <>
            {finding && !checked && <span class="tag keep">例外・保留</span>}
            {regionSummary(stats)}
            {stats.sample && <span class="muted">（框內文字：{stats.sample.length > 30 ? `${stats.sample.slice(0, 30)}…` : stats.sample}）</span>}
            {warnings.map((w) => (
              <span class="region-warn" key={w}>
                ⚠️ {w}
              </span>
            ))}
          </>
        )}
      </p>
    </li>
  );
}

function CleanResult({ output, onDownloadAgain }: { output: NonNullable<DocState['output']>; onDownloadAgain: () => void }) {
  const rawBad = output.raw.length > 0 && !output.rawExpected;
  const ok = output.residual === 0 && !rawBad;
  return (
    <div class={`result ${ok ? 'good' : 'bad'}`} data-testid="clean-result">
      <div>
        <div>
          {ok ? '✅' : '⚠️'} 已產生 <b>{output.name}</b>：移除 {output.removed} 項{output.kept > 0 && `、保留例外 / 手動項目 ${output.kept} 項`}
        </div>
        <div class="small">
          驗證：重新掃描殘留 <b>{output.residual}</b>・原始位元組殘留 <b data-testid="raw-residual">{output.raw.length}</b>
          {output.raw.length > 0 && output.rawExpected && '（含你保留的項目）'}
        </div>
        {output.raw.length > 0 && (
          <details class="raw-details">
            <summary>查看原始位元組中的殘留位置</summary>
            <ul>
              {output.raw.slice(0, 50).map((h, i) => (
                <li key={i}>
                  <code>{h.where}</code> <mark>{h.text}</mark> <span class="muted">{h.context}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button type="button" class="link" onClick={onDownloadAgain}>
        再次下載
      </button>
    </div>
  );
}

interface RowProps {
  f: Finding;
  checked: boolean;
  disabled: boolean;
  focused: boolean;
  onToggle: (v: boolean) => void;
  onLocate?: () => void;
}

function FindingRow({ f, checked, disabled, focused, onToggle, onLocate }: RowProps) {
  const ctx = f.context ?? { before: '', match: f.matchText, after: '' };
  return (
    <li class={`finding${f.removable ? '' : ' report'}${f.removable && !checked ? ' kept' : ''}${focused ? ' focused' : ''}`} data-finding-id={f.id}>
      <label>
        {f.removable ? <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onToggle(e.currentTarget.checked)} /> : <span class="nocheck">ℹ️</span>}
        <span class="snippet">
          {f.thumbnail && <img class="thumb" src={f.thumbnail} alt="" />}
          <span class="ctx">{ctx.before}</span>
          <mark>{ctx.match}</mark>
          <span class="ctx">{ctx.after}</span>
        </span>
        <span class="where">
          {onLocate ? (
            <button
              type="button"
              class="locate"
              onClick={(e) => {
                e.preventDefault();
                onLocate();
              }}
              title="在預覽中顯示位置"
            >
              📍 {f.where}
            </button>
          ) : (
            f.where
          )}
        </span>
      </label>
      {(f.note || (f.removable && !checked)) && (
        <p class="note">
          {f.removable && !checked && <span class="tag keep">例外・保留</span>}
          {f.confidence === 'high' && f.removable && <span class="tag high">高信心</span>}
          {f.confidence === 'low' && f.removable && <span class="tag low">請確認</span>}
          {f.note}
        </p>
      )}
    </li>
  );
}
