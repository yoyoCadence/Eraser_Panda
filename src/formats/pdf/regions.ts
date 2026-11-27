import { PDFName, PDFNumber, type PDFArray, type PDFDict, type PDFDocument, type PDFObject } from 'pdf-lib';
import type { Candidate } from '../../core/candidates';
import type { Region, RegionStats } from '../../core/types';
import { apply, placementsOf, type Placement, type TextRun } from './content/interpret';
import { addRemoval, type PdfTextScan } from './content/textScan';
import { denormRect, lookupArray, lookupDict, nameOf } from './pdfdoc';
import { removeAnnot } from './structure';

/**
 * User-drawn removal regions ("remove everything in this box on pages 3–10").
 *
 * What counts as inside (all tested on every page of the range, at that page's own position):
 *   - text:            a glyph whose centre is inside the box            → the glyph is removed (with advance kept)
 *   - images:          at least half of the image is inside              → the whole placement is removed
 *                      less than half (e.g. a scanned page)              → left alone, reported as "partial"
 *   - vector graphics: (almost) entirely inside                          → removed; clipping paths never are
 *   - annotations:     at least half inside (stamps, comments, …)        → removed; form fields / links are not
 * Content of a shared Form XObject is only removed when EVERY place the form is drawn falls inside the region —
 * otherwise removing it would also erase it from pages / positions the user did not select ("shared").
 */

type Box = [number, number, number, number];

const IMAGE_SHARE = 0.5;
const PATH_SHARE = 0.9;
const ANNOT_SHARE = 0.5;
const SKIP_ANNOTS = new Set(['Widget', 'Link', 'Popup']);

/** Fraction of `a`'s area that lies inside `b` (degenerate boxes — straight lines — are padded slightly). */
export function shareInside(a: Box, b: Box): number {
  const pad = 0.25;
  const ax1 = a[0] - (a[2] - a[0] < pad * 2 ? pad : 0);
  const ax2 = a[2] + (a[2] - a[0] < pad * 2 ? pad : 0);
  const ay1 = a[1] - (a[3] - a[1] < pad * 2 ? pad : 0);
  const ay2 = a[3] + (a[3] - a[1] < pad * 2 ? pad : 0);
  const w = Math.max(0, Math.min(ax2, b[2]) - Math.max(ax1, b[0]));
  const h = Math.max(0, Math.min(ay2, b[3]) - Math.max(ay1, b[1]));
  const area = (ax2 - ax1) * (ay2 - ay1);
  return area > 0 ? (w * h) / area : 0;
}

function bboxOf(points: Array<[number, number]>): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const contains = (b: Box, [x, y]: [number, number]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

type Verdict = 'all' | 'some' | 'none';

/** Is the object inside the region at EVERY placement of its source? */
function verdict(placements: readonly Placement[], test: (pl: Placement & { t: NonNullable<Placement['t']> }) => boolean): Verdict {
  let inside = 0;
  for (const pl of placements) if (pl.t && test(pl as Placement & { t: NonNullable<Placement['t']> })) inside++;
  return inside === 0 ? 'none' : inside === placements.length ? 'all' : 'some';
}

export function rangeLabel(r: Pick<Region, 'from' | 'to'>): string {
  return r.from === r.to ? `第 ${r.from} 頁` : `第 ${r.from}–${r.to} 頁`;
}

export function regionSummary(s: RegionStats): string {
  const parts = [s.text ? `${s.text} 個字` : '', s.images ? `${s.images} 張圖片` : '', s.paths ? `${s.paths} 個向量圖形` : '', s.annots ? `${s.annots} 個註解` : ''].filter(Boolean);
  return parts.length ? `移除 ${parts.join('、')}` : '框內沒有可移除的內容';
}

export function regionWarnings(s: RegionStats): string[] {
  const out: string[] = [];
  if (s.partial) out.push(`${s.partial} 張圖片只有一部分在框內，圖片無法局部刪除，未移除（例如掃描頁面）`);
  if (s.shared) out.push(`${s.shared} 個跨頁共用物件也出現在範圍外的頁面或位置，為避免誤刪而保留；把頁面範圍擴大到涵蓋所有使用頁面即可移除`);
  return out;
}

export function scanRegions(doc: PDFDocument, scan: PdfTextScan, regions: readonly Region[]): { candidates: Candidate[]; stats: Record<string, RegionStats> } {
  const candidates: Candidate[] = [];
  const stats: Record<string, RegionStats> = {};
  const pageCount = doc.getPageCount();
  const memo = new Map<string, Placement[]>();
  const res = scan.result;

  for (const region of regions) {
    const from = Math.max(1, Math.min(region.from, region.to));
    const to = Math.min(pageCount, Math.max(region.from, region.to));
    const boxes = new Map<number, Box>();
    for (let p = from; p <= to; p++) boxes.set(p, denormRect(doc, p - 1, region.rect));
    const st: RegionStats = { text: 0, images: 0, paths: 0, annots: 0, partial: 0, shared: 0, pages: boxes.size, sample: '' };
    const shared = new Set<string>();
    const glyphs: Array<{ run: TextRun; glyph: number }> = [];
    const deletes: Array<{ key: string; instr: number }> = [];
    const annots: Array<{ list: PDFArray; ref: PDFObject; dict: PDFDict }> = [];
    const sampleText = new Map<TextRun, string>();

    if (boxes.size) {
      // text
      for (const run of res.runs) {
        const pls = placementsOf(res, run.src, memo);
        if (!pls.some((pl) => boxes.has(pl.page))) continue;
        run.quads.forEach((q, gi) => {
          const cx = (q[0]![0] + q[1]![0] + q[2]![0] + q[3]![0]) / 4;
          const cy = (q[0]![1] + q[1]![1] + q[2]![1] + q[3]![1]) / 4;
          const v = verdict(pls, (pl) => {
            const b = boxes.get(pl.page);
            return !!b && contains(b, apply(pl.t, cx, cy));
          });
          if (v === 'all') {
            glyphs.push({ run, glyph: gi });
            st.text++;
            if (sampleText.size < 40) sampleText.set(run, (sampleText.get(run) ?? '') + run.glyphs[gi]!.text);
          } else if (v === 'some') shared.add(run.src.key);
        });
      }
      // images
      for (const im of res.images) {
        const pls = placementsOf(res, im.src, memo);
        if (!pls.some((pl) => boxes.has(pl.page))) continue;
        let partial = false;
        const v = verdict(pls, (pl) => {
          const b = boxes.get(pl.page);
          if (!b) return false;
          const share = shareInside(bboxOf(im.quad.map(([x, y]) => apply(pl.t, x, y))), b);
          if (share > 0.02 && share < IMAGE_SHARE) partial = true;
          return share >= IMAGE_SHARE;
        });
        if (v === 'all') {
          deletes.push({ key: im.src.key, instr: im.instr });
          st.images++;
        } else if (v === 'some') shared.add(im.src.key);
        else if (partial) st.partial++;
      }
      // vector graphics
      for (const path of res.paths) {
        if (path.clip) continue;
        const pls = placementsOf(res, path.src, memo);
        if (!pls.some((pl) => boxes.has(pl.page))) continue;
        const corners: Array<[number, number]> = [
          [path.bbox[0], path.bbox[1]],
          [path.bbox[2], path.bbox[1]],
          [path.bbox[2], path.bbox[3]],
          [path.bbox[0], path.bbox[3]],
        ];
        const v = verdict(pls, (pl) => {
          const b = boxes.get(pl.page);
          return !!b && shareInside(bboxOf(corners.map(([x, y]) => apply(pl.t, x, y))), b) >= PATH_SHARE;
        });
        if (v === 'all') {
          for (const instr of path.instrs) deletes.push({ key: path.src.key, instr });
          st.paths++;
        } else if (v === 'some') shared.add(path.src.key);
      }
      // annotations (page-level objects: no sharing)
      for (const [p, b] of boxes) {
        const list = doc.getPage(p - 1).node.Annots();
        if (!list) continue;
        for (let i = 0; i < list.size(); i++) {
          const ref = list.get(i);
          const dict = lookupDict(doc, ref);
          if (!dict || SKIP_ANNOTS.has(nameOf(dict.lookup(PDFName.of('Subtype'))) ?? '')) continue;
          const rect = lookupArray(doc, dict.get(PDFName.of('Rect')));
          if (!rect || rect.size() < 4) continue;
          const n = [0, 1, 2, 3].map((k) => (rect.lookup(k) as PDFNumber | undefined)?.asNumber?.() ?? 0);
          const box: Box = [Math.min(n[0]!, n[2]!), Math.min(n[1]!, n[3]!), Math.max(n[0]!, n[2]!), Math.max(n[1]!, n[3]!)];
          if (shareInside(box, b) >= ANNOT_SHARE) {
            annots.push({ list, ref, dict });
            st.annots++;
          }
        }
      }
    }
    st.shared = shared.size;
    // distinct snippets (the same header text on 80 pages is shown once)
    st.sample = [...new Set([...sampleText.values()].map((t) => t.trim()).filter(Boolean))].join(' ').slice(0, 60);
    stats[region.id] = st;

    const count = st.text + st.images + st.paths + st.annots;
    if (!count) continue;
    const label = rangeLabel({ from, to });
    candidates.push({
      finding: {
        id: `region:${region.id}`,
        kind: 'region',
        location: 'region',
        matchText: '框選區域',
        context: { before: '', match: '框選區域', after: `：${regionSummary(st)}` },
        where: `${label}・框選區域`,
        page: from,
        confidence: 'high',
        removable: true,
        defaultSelected: true,
        note: [regionSummary(st), ...regionWarnings(st)].join('；'),
      },
      remove: () => {
        for (const g of glyphs) addRemoval(scan.plan, g.run, g.glyph);
        for (const d of deletes) {
          const set = scan.deletes.get(d.key) ?? new Set<number>();
          set.add(d.instr);
          scan.deletes.set(d.key, set);
        }
        for (const a of annots) removeAnnot(doc, a.list, a.ref, a.dict);
      },
    });
  }
  return { candidates, stats };
}
