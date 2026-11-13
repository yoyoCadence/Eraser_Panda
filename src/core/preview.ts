import type { Candidate, TextUnit } from './candidates';
import type { LocationKind, PreviewBlock, PreviewLine } from './types';

const TAG: Partial<Record<LocationKind, string>> = {
  header: '頁首',
  footer: '頁尾',
  watermark: '浮水印',
  textbox: '文字方塊',
  comment: '註解',
  notes: '備忘稿',
  master: '母片',
  chart: '圖表',
  formula: '公式',
  property: '屬性',
  bookmark: '書籤',
};

/**
 * Build a structured preview from text units: every unit that has a hit, plus `context` neighbouring units of the
 * same part (so a hit in a paragraph is shown with the paragraphs around it). Blocks follow document order and are
 * titled by location (slide, header, sheet …).
 */
export function buildPreview(units: readonly TextUnit[], candidates: readonly Candidate[], context = 1, maxLines = 400): PreviewBlock[] {
  const marks = new Map<TextUnit, PreviewLine['marks']>();
  for (const c of candidates) {
    if (!c.span) continue;
    const list = marks.get(c.span.unit) ?? [];
    list.push({ start: c.span.start, end: c.span.end, id: c.finding.id });
    marks.set(c.span.unit, list);
  }
  if (!marks.size) return [];

  // which units to show: hits + neighbours within the same part
  const show = new Set<number>();
  units.forEach((u, i) => {
    if (!marks.has(u)) return;
    for (let k = i - context; k <= i + context; k++) if (units[k] && units[k]!.part === u.part) show.add(k);
  });

  const blocks: PreviewBlock[] = [];
  let lines = 0;
  let lastIndex = -2;
  for (const i of [...show].sort((a, b) => a - b)) {
    if (lines >= maxLines) break;
    const u = units[i]!;
    const title = blockTitle(u);
    let block = blocks[blocks.length - 1];
    if (!block || block.title !== title) {
      block = { title, page: u.page, lines: [] };
      blocks.push(block);
    } else if (i !== lastIndex + 1) block.lines.push({ text: '…', marks: [] });
    const text = u.segments.map((s) => s.text).join('');
    block.lines.push({ text, marks: (marks.get(u) ?? []).sort((a, b) => a.start - b.start), tag: TAG[u.location] });
    lines++;
    lastIndex = i;
  }
  return blocks;
}

/** Group key: drop paragraph numbers so all paragraphs of the body / a slide / a sheet share one block. */
function blockTitle(u: TextUnit): string {
  return u.where
    .replace(/^內文第 \d+ 段$/, '內文')
    .replace(/![A-Z]+\d+.*$/, '')
    .replace(/(等 \d+ 個儲存格|公式結果|公式| 註解| 討論串註解)$/, '')
    .replace(/・(頁首|頁尾|資料標籤)$/, '')
    .trim();
}
