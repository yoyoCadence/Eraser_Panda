import { useEffect, useRef, useState } from 'preact/hooks';
import type { Finding } from '../core/types';
import { openForPreview, renderPage, type OpenedPdf, type PdfJsDoc } from '../formats/pdf/render';

interface Props {
  bytes: Uint8Array;
  /** Findings to overlay (only in "original" mode). */
  findings: Finding[];
  selected: Set<string>;
  focusId: string | null;
  /** bump to re-trigger the flash on the same finding */
  focusTick: number;
  onPick?: (id: string) => void;
}

interface PageInfo {
  w: number;
  h: number;
}

/** Scrollable stack of rendered PDF pages with highlight boxes; renders pages lazily as they scroll into view. */
export function PdfPreview({ bytes, findings, selected, focusId, focusTick, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfJsDoc | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState('');

  // open document
  useEffect(() => {
    let cancelled = false;
    let opened: OpenedPdf | null = null;
    setDoc(null);
    setPages([]);
    setError('');
    (async () => {
      try {
        opened = await openForPreview(bytes);
        const d = opened.doc;
        const info: PageInfo[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const p = await d.getPage(i);
          const v = p.getViewport({ scale: 1 });
          info.push({ w: v.width, h: v.height });
        }
        if (cancelled) return void opened.destroy();
        setPages(info);
        setDoc(d);
      } catch (e) {
        if (!cancelled) setError(`預覽失敗：${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [bytes]);

  // track available width
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // scroll to focused finding
  useEffect(() => {
    if (!focusId || !host.current) return;
    const f = findings.find((x) => x.id === focusId);
    if (!f?.page) return;
    const pageEl = host.current.querySelector<HTMLElement>(`[data-page="${f.page}"]`);
    if (!pageEl) return;
    const box = host.current.querySelector<HTMLElement>(`[data-hl="${CSS.escape(focusId)}"]`);
    (box ?? pageEl).scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (box) {
      box.classList.remove('flash');
      void box.offsetWidth; // restart animation
      box.classList.add('flash');
    }
  }, [focusId, focusTick, pages.length]);

  const byPage = new Map<number, Finding[]>();
  for (const f of findings) if (f.page && f.rects?.length) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);

  return (
    <div class="pdf-preview" ref={host} data-testid="pdf-preview">
      {error && <p class="error">{error}</p>}
      {!error && !doc && <p class="muted">載入預覽…</p>}
      {doc &&
        width > 0 &&
        pages.map((p, i) => (
          <Page key={i} doc={doc} n={i + 1} info={p} width={width - 4}>
            {(byPage.get(i + 1) ?? []).flatMap((f) =>
              f.rects!.map((r, k) => (
                <button
                  type="button"
                  key={`${f.id}:${k}`}
                  data-hl={k === 0 ? f.id : undefined}
                  class={`hl${selected.has(f.id) ? '' : ' kept'}`}
                  style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                  title={`${f.matchText}・${f.where}`}
                  onClick={() => onPick?.(f.id)}
                />
              )),
            )}
          </Page>
        ))}
    </div>
  );
}

function Page({ doc, n, info, width, children }: { doc: PdfJsDoc; n: number; info: PageInfo; width: number; children: preact.ComponentChildren }) {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const { canvas } = await renderPage(doc, n, width);
        if (cancelled || !holder.current) return;
        holder.current.querySelector('canvas')?.remove();
        holder.current.prepend(canvas);
      } catch {
        /* page failed to render — leave the placeholder */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, doc, n, width]);

  return (
    <div class="pdf-page" data-page={n} ref={holder} style={{ width: `${width}px`, height: `${(width * info.h) / info.w}px` }}>
      {children}
      <span class="page-no">{n}</span>
    </div>
  );
}
