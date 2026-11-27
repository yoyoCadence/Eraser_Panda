export interface Busy {
  file: string;
  /** 1-based position of this file in a batch */
  index: number;
  total: number;
  /** index into the step list */
  step: number;
}

/**
 * Full-window "working" overlay while files are cleaned. Cleaning runs on the main thread, so the page cannot
 * update text mid-step; the spinner is a transform animation, which the browser's compositor keeps turning even
 * while the main thread is busy, and the step text is refreshed between steps.
 */
export function BusyOverlay({ busy, steps }: { busy: Busy; steps: readonly string[] }) {
  const done = (busy.index - 1 + busy.step / steps.length) / busy.total;
  return (
    <div class="busy-overlay" role="status" aria-live="polite" aria-busy="true" data-testid="busy-overlay">
      <div class="busy-card">
        <div class="busy-spinner" aria-hidden="true" />
        <div class="busy-text">
          <b>正在清除{busy.total > 1 ? `（第 ${busy.index} / ${busy.total} 個檔案）` : ''}</b>
          <span class="busy-file">{busy.file}</span>
          <ol class="busy-steps">
            {steps.map((s, i) => (
              <li key={s} class={i < busy.step ? 'done' : i === busy.step ? 'now' : ''}>
                {i < busy.step ? '✓' : i === busy.step ? '›' : '·'} {s}
              </li>
            ))}
          </ol>
          <div class="busy-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(done * 100)}%` }} />
          </div>
          <span class="muted small">大型檔案可能需要數十秒，請勿關閉頁面。檔案只在這台電腦上處理。</span>
        </div>
      </div>
    </div>
  );
}
