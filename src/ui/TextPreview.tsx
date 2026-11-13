import { useEffect, useRef } from 'preact/hooks';
import type { PreviewBlock, PreviewLine } from '../core/types';

interface Props {
  blocks: PreviewBlock[];
  selected: Set<string>;
  focusId: string | null;
  focusTick: number;
  onPick?: (id: string) => void;
}

/** Structured preview for Office / text files: sections (slide, header, sheet …) with every hit highlighted. */
export function TextPreview({ blocks, selected, focusId, focusTick, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId || !host.current) return;
    const el = host.current.querySelector<HTMLElement>(`[data-hl="${CSS.escape(focusId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }, [focusId, focusTick]);

  return (
    <div class="text-preview" ref={host} data-testid="text-preview">
      {blocks.map((b, i) => (
        <section class="tp-block" key={`${b.title}${i}`}>
          <h3>{b.title}</h3>
          {b.lines.map((l, k) => (
            <Line key={k} line={l} selected={selected} onPick={onPick} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Line({ line, selected, onPick }: { line: PreviewLine; selected: Set<string>; onPick?: (id: string) => void }) {
  if (line.text === '…' && !line.marks.length) return <p class="tp-gap">⋯</p>;
  const parts: preact.ComponentChildren[] = [];
  let pos = 0;
  for (const m of line.marks) {
    if (m.start < pos) continue;
    if (m.start > pos) parts.push(line.text.slice(pos, m.start));
    parts.push(
      <mark
        key={m.id}
        data-hl={m.id}
        class={selected.has(m.id) ? '' : 'kept'}
        role="button"
        tabIndex={0}
        title={selected.has(m.id) ? '將被移除（點擊在清單中顯示）' : '例外・保留'}
        onClick={() => onPick?.(m.id)}
        onKeyDown={(e) => e.key === 'Enter' && onPick?.(m.id)}
      >
        {line.text.slice(m.start, m.end)}
      </mark>,
    );
    pos = m.end;
  }
  if (pos < line.text.length) parts.push(line.text.slice(pos));
  return (
    <p class="tp-line">
      {line.tag && <span class="tp-tag">{line.tag}</span>}
      {parts}
    </p>
  );
}
