import { describe, expect, it } from 'vitest';
import { reportCsv, reportJson, type ReportFile } from '../src/core/report';
import type { Finding } from '../src/core/types';

const f = (matchText: string, where = '頁首 1'): Finding => ({
  id: matchText,
  kind: 'text',
  location: 'header',
  matchText,
  context: { before: 'SECRET DOCUMENT CONTENT ', match: matchText, after: ' MORE CONTENT' },
  where,
  confidence: 'high',
  removable: true,
  defaultSelected: true,
});

const file: ReportFile = {
  file: 'a.docx',
  format: 'docx',
  outputName: 'a_clean.docx',
  processedAt: '2026-01-01T00:00:00.000Z',
  sizeIn: 10,
  sizeOut: 9,
  sha256In: 'aa',
  sha256Out: 'bb',
  removed: [f('Confidential'), f('=HYPERLINK("http://x")', 'cell, "quoted"')],
  kept: [f('Secret')],
  manual: [],
  warnings: [],
  residual: 0,
  rawResidual: 1,
};

describe('audit report', () => {
  it('CSV has a BOM, one row per item, escapes quotes and neutralises formulas', () => {
    const csv = reportCsv([file]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(lines[2]).toContain('"cell, ""quoted"""');
    expect(lines[3]).toContain('保留（例外）');
  });

  it('never includes surrounding document content', () => {
    expect(reportCsv([file])).not.toContain('SECRET DOCUMENT CONTENT');
    expect(reportJson([file])).not.toContain('SECRET DOCUMENT CONTENT');
    expect(JSON.parse(reportJson([file])).files[0].removed[0]).toEqual({ kind: 'text', location: 'header', where: '頁首 1', text: 'Confidential', confidence: 'high' });
  });
});
