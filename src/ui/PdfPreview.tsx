import { useEffect, useRef, useState } from 'preact/hooks';
import type { Finding, NormRect, Region } from '../core/types';
import { openForPreview, renderPage, type OpenedPdf, type PdfJsDoc } from '../formats/pdf/render';

export type RegionState = 'on' | 'off' | 'empty';

interface Props {
  bytes: Uint8Array;
  /** Findings to overlay (only in "original" mode). */
  findings: Finding[];
  selected: Set<string>;
  focusId: string | null;
  /** bump to re-trigger the flash on the same finding */
  focusTick: number;
  onPick?: (id: string) => void;
  /** user-drawn removal regions, drawn on every page of their range */
  regions?: Region[];
  regionState?: (r: Region) => RegionState;
  /** drag on a page to draw a new region */
  drawing?: boolean;
  onDrawn?: (page: number, rect: NormRect) => void;
  /** region being drawn / configured (not yet added) */
  pending?: { rect: NormRect; from: number; to: number } | null;
}

interface PageInfo {
  w: number;
  h: number;
}

interface Spot {
  f: Finding;
  rects: NormRect[];
  /** first page of this finding: carries the locate anchor */
  anchor: boolean;
}

const pct = (r: NormRect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

/** Scrollable stack of rendered PDF pages with highlight boxes; renders pages lazily as they scroll into view. */
export function PdfPreview({ bytes, findings, selected, focusId, focusTick, onPick, regions = [], regionState, drawing, onDrawn, pending }: Props) {
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

  // scroll to focused finding / region
  useEffect(() => {
    if (!focusId || !host.current) return;
    const f = findings.find((x) => x.id === focusId);
    const region = regions.find((r) => `region:${r.id}` === focusId);
    const page = f?.highlights?.[0]?.page ?? f?.page ?? region?.from;
    if (!page) return;
    const pageEl = host.current.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!pageEl) return;
    const box = host.current.querySelector<HTMLElement>(`[data-hl="${CSS.escape(focusId)}"]`);
    (box ?? pageEl).scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (box) {
      box.classList.remove('flash');
      void box.offsetWidth; // restart animation
      box.classList.add('flash');
    }
  }, [focusId, focusTick, pages.length]);

  const byPage = new Map<number, Spot[]>();
  for (const f of findings) {
    if (f.kind === 'region') continue; // drawn from `regions`
    const spots = f.highlights ?? (f.page && f.rects?.length ? [{ page: f.page, rects: f.rects }] : []);
    spots.forEach((h, i) => {
      const list = byPage.get(h.page);
      const spot = { f, rects: h.rects, anchor: i === 0 };
      if (list) list.push(spot);
      else byPage.set(h.page, [spot]);
    });
  }

  return (
    <div class={`pdf-preview${drawing ? ' drawing' : ''}`} ref={host} data-testid="pdf-preview">
      {error && <p class="error">{error}</p>}
      {!error && !doc && <p class="muted">載入預覽…</p>}
      {doc &&
        width > 0 &&
        pages.map((p, i) => {
          const n = i + 1;
          return (
            <Page key={i} doc={doc} n={n} info={p} width={width - 4}>
              {(byPage.get(n) ?? []).flatMap(({ f, rects, anchor }) =>
                rects.map((r, k) => (
                  <button
                    type="button"
                    key={`${f.id}:${k}`}
                    data-hl={anchor && k === 0 ? f.id : undefined}
                    class={`hl${selected.has(f.id) ? '' : ' kept'}`}
                    style={pct(r)}
                    title={`${f.matchText}・${f.where}${selected.has(f.id) ? '・將被移除' : '・保留'}`}
                    onClick={() => onPick?.(f.id)}
                  />
                )),
              )}
              {regions.map((r, idx) =>
                n >= Math.min(r.from, r.to) && n <= Math.max(r.from, r.to) ? (
                  <button
                    type="button"
                    key={`region:${r.id}`}
                    data-hl={n === Math.min(r.from, r.to) ? `region:${r.id}` : undefined}
                    data-region={r.id}
                    class={`region-box ${regionState?.(r) ?? 'on'}`}
                    style={pct(r.rect)}
                    title={`框選區域 ${idx + 1}`}
                    onClick={() => onPick?.(`region:${r.id}`)}
                  >
                    <span class={`region-tag${r.rect.y < 0.05 ? ' below' : ''}`}>✂️ {idx + 1}</span>
                  </button>
                ) : null,
              )}
              {pending && n >= Math.min(pending.from, pending.to) && n <= Math.max(pending.from, pending.to) && <div class="region-box pending" style={pct(pending.rect)} data-testid="pending-region" />}
              {drawing && <DrawLayer onDone={(rect) => onDrawn?.(n, rect)} />}
            </Page>
          );
        })}
    </div>
  );
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Transparent layer over a page that turns a drag into a normalised rectangle. */
function DrawLayer({ onDone }: { onDone: (rect: NormRect) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  const [rect, setRect] = useState<NormRect | null>(null);
  const at = (e: PointerEvent): [number, number] => {
    const b = el.current!.getBoundingClientRect();
    return [clamp((e.clientX - b.left) / b.width), clamp((e.clientY - b.top) / b.height)];
  };
  const toRect = (a: [number, number], b: [number, number]): NormRect => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });
  return (
    <div
      ref={el}
      class="draw-layer"
      data-testid="draw-layer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.current!.setPointerCapture(e.pointerId);
        start.current = at(e);
        setRect(toRect(start.current, start.current));
      }}
      onPointerMove={(e) => {
        if (start.current) setRect(toRect(start.current, at(e)));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        setRect(null);
        if (!s) return;
        const r = toRect(s, at(e));
        if (r.w > 0.008 && r.h > 0.004) onDone(r); // ignore clicks / accidental tiny drags
      }}
      onPointerCancel={() => {
        start.current = null;
        setRect(null);
      }}
    >
      {rect && <div class="region-box pending" style={pct(rect)} />}
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
