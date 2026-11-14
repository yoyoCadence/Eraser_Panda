import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules';
import { textHandler } from '../src/formats/text/handler';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function cleanAll(text: string, fileName?: string) {
  const ctx = { rules: [...DEFAULT_RULES], fileName };
  const scan = await textHandler.scan(enc(text), ctx);
  return dec(await textHandler.apply(enc(text), ctx, new Set(scan.findings.map((f) => f.id))));
}

describe('delimited text keeps its structure', () => {
  it('CSV: removing a cell value never removes the delimiter (columns must not shift)', async () => {
    const out = await cleanAll('Title,Classification,Year\nPlan,Confidential,2024\nBudget,Internal Use Only,2025\n', 'data.csv');
    expect(out).toBe('Title,Classification,Year\nPlan,,2024\nBudget,,2025\n');
    for (const line of out.trim().split('\n')) expect(line.split(',')).toHaveLength(3);
  });

  it('TSV and semicolon CSV are recognised by content even without a file name', async () => {
    expect(await cleanAll('a\tb\tc\nx\tSecret\tz\ny\tq\tw\n')).toBe('a\tb\tc\nx\t\tz\ny\tq\tw\n');
    expect(await cleanAll('a;b;c\nx;Secret;z\ny;q;w\n')).toBe('a;b;c\nx;;z\ny;q;w\n');
  });

  it('prose text files still get tidy removal', async () => {
    expect(await cleanAll('Status: Top Secret | Page 1\nThis is confidential.\n', 'notes.txt')).toBe('Status: Page 1\nThis is.\n');
  });
});
