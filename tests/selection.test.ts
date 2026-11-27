import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules';
import type { Finding, ScanResult } from '../src/core/types';
import { textHandler } from '../src/formats/text/handler';
import { initialSelection, scanBytes, type DocState } from '../src/ui/engine';

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

describe('background re-scan', () => {
  it('keeps selection edits the user made while the scan was running', async () => {
    const ctx = { rules: [...DEFAULT_RULES], fileName: 'a.txt' };
    const bytes = new TextEncoder().encode('Plan - Confidential\nSecret appendix\n');
    const first = await textHandler.scan(bytes, ctx);
    const state: { result?: ScanResult; selected: Set<string> } = { result: first, selected: initialSelection(first) };
    expect(state.selected.size).toBe(2);
    let patched: Partial<DocState> = {};
    const done = scanBytes('k', bytes, 'text', ctx, (_k, p) => (patched = p), () => state);
    // the user unchecks a finding while the re-scan is still running
    const kept = [...state.selected][0]!;
    state.selected = new Set([...state.selected].filter((id) => id !== kept));
    await done;
    expect(patched.selected?.has(kept)).toBe(false);
    expect(patched.selected?.size).toBe(1);
  });
});
