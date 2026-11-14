import { describe, expect, it } from 'vitest';
import type { Finding, ScanResult } from '../src/core/types';
import { initialSelection } from '../src/ui/engine';

const f = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  kind: 'text',
  location: 'body',
  matchText: id,
  where: '',
  confidence: 'high',
  removable: true,
  defaultSelected: true,
  ...extra,
});
const res = (findings: Finding[]): ScanResult => ({ format: 'docx', findings, warnings: [] });

describe('initialSelection', () => {
  it('uses defaults on a first scan', () => {
    const r = res([f('a'), f('b', { defaultSelected: false }), f('c', { removable: false })]);
    expect([...initialSelection(r)]).toEqual(['a']);
  });

  it('keeps the user’s exceptions and opt-ins across a re-scan; new findings get defaults', () => {
    const before = res([f('a'), f('b'), f('low', { defaultSelected: false })]);
    const userSelected = new Set(['a', 'low']); // user unchecked "b" and opted into "low"
    const after = res([f('a'), f('b'), f('low', { defaultSelected: false }), f('new'), f('newLow', { defaultSelected: false })]);
    expect([...initialSelection(after, { result: before, selected: userSelected })].sort()).toEqual(['a', 'low', 'new']);
  });
});
