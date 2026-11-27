/** Compact page list for labels: [1,2,3,5,7,8] → "1–3、5、7–8". */
export function pageList(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join('、');
}

/** "第 1–3、5 頁" — shortened with "等" when the list would be very long. */
export function pagesLabel(pages: Iterable<number>, max = 6): string {
  const list = pageList(pages).split('、');
  return `第 ${list.length > max ? `${list.slice(0, max).join('、')} 等` : list.join('、')} 頁`;
}
