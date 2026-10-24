import { describe, expect, expectTypeOf, it } from 'vitest';

import { branchFor } from '../utils/index.js';
import type { laneWorktreePath } from '../utils/worktree-location.js';
import type { worktreeDirName } from '../worktree/worktree-name.js';
import { isNumericWorkKey, issueNumberOf, toWorkKey, workKeyFromIssue, type WorkKey } from './work-key.js';

describe('workKeyFromIssue', () => {
  it('workKeyFromIssue returns the decimal string of the issue number', () => {
    expect(workKeyFromIssue(123)).toBe('123');
    expect(workKeyFromIssue(0)).toBe('0');
  });

  it('throws RangeError for non-integer, negative or unsafe numbers', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => workKeyFromIssue(bad)).toThrow(RangeError);
    }
  });
});

describe('toWorkKey', () => {
  it('keeps a tracker key as is and trims whitespace', () => {
    expect(toWorkKey('PROJ-123')).toBe('PROJ-123');
    expect(toWorkKey('  PROJ-1 ')).toBe('PROJ-1');
  });

  it('rejects empty and ref-unsafe keys', () => {
    for (const bad of ['', '   ', 'a/b', '-x', 'a b']) {
      expect(() => toWorkKey(bad)).toThrow();
    }
  });
});

describe('isNumericWorkKey / issueNumberOf', () => {
  it('detects canonical decimal keys only', () => {
    expect(isNumericWorkKey(toWorkKey('123'))).toBe(true);
    expect(isNumericWorkKey(toWorkKey('0'))).toBe(true);
    for (const k of ['PROJ-123', '007', '1e3']) expect(isNumericWorkKey(toWorkKey(k))).toBe(false);
  });

  it('issueNumberOf returns the number or names the offending key', () => {
    expect(issueNumberOf(toWorkKey('123'))).toBe(123);
    expect(() => issueNumberOf(toWorkKey('PROJ-123'))).toThrow(/PROJ-123/);
  });
});

describe('WorkKey typing', () => {
  it('naming helpers take a WorkKey, not a bare number or string', () => {
    expectTypeOf<Parameters<typeof branchFor>[0]>().toEqualTypeOf<WorkKey>();
    expectTypeOf<Parameters<typeof worktreeDirName>[1]>().toEqualTypeOf<WorkKey>();
    expectTypeOf<Parameters<typeof laneWorktreePath>[0]['key']>().toEqualTypeOf<WorkKey>();
    // @ts-expect-error a bare number is not a WorkKey
    const _uncalled = (): string => branchFor(123, 'x');
    // @ts-expect-error a plain string is not a WorkKey
    const key: WorkKey = 'x';
    expect(key).toBe('x');
  });
});
