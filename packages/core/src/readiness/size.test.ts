import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { checkIssueSize, estimatePlanSize, isSpikeIssue, planOverBudget, type PlanSizeEstimate } from './size.js';

const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join('\n');
const checkboxes = (n: number) => Array.from({ length: n }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');

const withSubs = (n: number, subs: number, box = false) =>
  Array.from({ length: n }, (_, i) =>
    [
      box ? `- [ ] criterion ${i + 1}` : `- item ${i + 1}`,
      ...Array.from({ length: subs }, (_, j) => (box ? `  - [ ] detail ${j + 1}` : `  - detail ${j + 1}`)),
    ].join('\n'),
  ).join('\n');
const indented = (text: string) =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

describe('checkIssueSize', () => {
  it('counts 3 top-level in-scope items with 3 two-space sub-bullets as 3 (#748)', () => {
    const inScope = `- allowlist\n  - a\n  - b\n  - c\n- denylist\n  - d\n  - e\n- third`;
    expect(checkIssueSize({ inScope, acceptanceCriteria: checkboxes(2) })).toEqual({ sizeOk: true });
  });

  it('does not count nested checkboxes under a top-level acceptance criterion (#748)', () => {
    const result = checkIssueSize({ inScope: items(2), acceptanceCriteria: withSubs(3, 2, true) });
    expect(result).toEqual({ sizeOk: true });
  });

  it('still fails 6 top-level items that each carry sub-bullets, and a 2-space-indented top-level list of 6 (#748)', () => {
    expect(checkIssueSize({ inScope: withSubs(6, 2), acceptanceCriteria: checkboxes(1) }).reason).toBe(
      'too big: 6 in-scope items, 1 acceptance criteria',
    );
    expect(checkIssueSize({ inScope: indented(items(6)), acceptanceCriteria: checkboxes(1) }).reason).toBe(
      'too big: 6 in-scope items, 1 acceptance criteria',
    );
    expect(checkIssueSize({ inScope: items(1), acceptanceCriteria: withSubs(6, 1, true) }).reason).toBe(
      'too big: 1 in-scope items, 6 acceptance criteria',
    );
  });

  it('counts an ordered list with 3-space-indented sub-bullets by its top-level items (#748)', () => {
    const inScope = '1. one\n   - a\n2. two\n   - b\n3. three\n   - c\n4. four\n5. five';
    expect(checkIssueSize({ inScope, acceptanceCriteria: '' })).toEqual({ sizeOk: true });
  });

  it('exempts a spike-labeled issue regardless of counts, case-insensitively (#748)', () => {
    for (const labels of [['spike'], ['Spike'], [' bug ', 'SPIKE ']]) {
      expect(checkIssueSize({ inScope: items(9), acceptanceCriteria: checkboxes(9), labels })).toEqual({
        sizeOk: true,
      });
    }
    for (const labels of [['spike-ish'], [] as string[]]) {
      expect(checkIssueSize({ inScope: items(9), acceptanceCriteria: checkboxes(9), labels }).sizeOk).toBe(false);
    }
  });

  it('isSpikeIssue matches only the exact label (#748)', () => {
    expect(isSpikeIssue(undefined)).toBe(false);
    expect(isSpikeIssue([])).toBe(false);
    expect(isSpikeIssue(['kind:spike'])).toBe(false);
    expect(isSpikeIssue(['spike'])).toBe(true);
  });

  it('passes at the boundary — 5 in-scope bullets and 5 checkbox criteria', () => {
    const result = checkIssueSize({ inScope: items(5), acceptanceCriteria: checkboxes(5) });
    expect(result).toEqual({ sizeOk: true });
  });

  it('fails when in-scope items exceed the limit', () => {
    const result = checkIssueSize({ inScope: items(6), acceptanceCriteria: checkboxes(2) });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 6 in-scope items, 2 acceptance criteria');
  });

  it('fails when acceptance criteria exceed the limit', () => {
    const result = checkIssueSize({ inScope: items(2), acceptanceCriteria: checkboxes(6) });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 2 in-scope items, 6 acceptance criteria');
  });

  it('does not count bullets inside a backtick-fenced block', () => {
    const inScope = [
      '- real item 1',
      '- real item 2',
      '```',
      ...Array.from({ length: 8 }, (_, i) => `- fenced ${i + 1}`),
      '```',
    ].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('does not count bullets inside a tilde-fenced block', () => {
    const inScope = [
      '- real item 1',
      '- real item 2',
      '~~~',
      ...Array.from({ length: 8 }, (_, i) => `- fenced ${i + 1}`),
      '~~~',
    ].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('does not count sub-bullets indented four or more spaces', () => {
    const inScope = ['- item 1', '- item 2', ...Array.from({ length: 8 }, (_, i) => `    - nested ${i + 1}`)].join(
      '\n',
    );
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('counts a prose-only section (no list markers) as 0 items', () => {
    const result = checkIssueSize({
      inScope: 'Just do the thing described above.',
      acceptanceCriteria: 'Looks good to me.',
    });
    expect(result).toEqual({ sizeOk: true });
  });

  it('passes with no reason for empty inputs', () => {
    const result = checkIssueSize({ inScope: '', acceptanceCriteria: '' });
    expect(result).toEqual({ sizeOk: true });
  });

  it('counts *, +, and ordered `1.` markers as list items', () => {
    const inScope = ['* item 1', '+ item 2', '1. item 3', '2) item 4', '- item 5', '- item 6'].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 6 in-scope items, 0 acceptance criteria');
  });
});

const t = (file: string, kind: 'added' | 'changed' | 'read' = 'changed') => ({ name: 'T', file, kind });
const sig = (file: string) => ({ symbol: 's', file, signature: '() => void' });
const sizes = (table: Record<string, number>) => (abs: string) => {
  const hit = Object.entries(table).find(([k]) => abs.endsWith(`/${k}`));
  return hit?.[1];
};

describe('estimatePlanSize (#3350)', () => {
  const worktree = '/wt';

  it('dedupes files, adds colocated tests and skips .test.ts inputs', () => {
    const est = estimatePlanSize(
      {
        targetTypes: [t('a/b.ts'), t('./a/b.ts', 'added'), t('c/d.test.ts'), t('e.tsx')],
        signatures: [sig('a/b.ts'), sig('f.md')],
      },
      { worktree, fileSize: () => 0 },
    );
    expect(est.changedFiles).toEqual(['a/b.ts', 'c/d.test.ts', 'e.tsx', 'f.md']);
    expect(est.testFiles).toEqual(['a/b.test.ts', 'e.test.tsx']);
  });

  it('does not add a colocated test that is already changed', () => {
    const est = estimatePlanSize(
      { targetTypes: [t('a.ts'), t('a.test.ts')], signatures: [] },
      { worktree, fileSize: () => 0 },
    );
    expect(est.testFiles).toEqual([]);
  });

  it('counts read files toward tokens but not changed files, and a read+changed path once as changed', () => {
    const est = estimatePlanSize(
      { targetTypes: [t('a.ts'), t('r.ts', 'read'), t('a.ts', 'read')], signatures: [] },
      { worktree, fileSize: sizes({ 'a.ts': 400, 'r.ts': 801 }) },
    );
    expect(est.changedFiles).toEqual(['a.ts']);
    expect(est.readFiles).toEqual(['r.ts']);
    // ceil((400 + 801) / 4) + 1 * 4000
    expect(est.estimatedTokens).toBe(301 + 4000);
  });

  it('ignores absolute and escaping paths, and a missing file contributes 0 bytes', () => {
    const est = estimatePlanSize(
      { targetTypes: [t('/etc/passwd'), t('../x.ts'), t('  '), t('new.ts', 'added')], signatures: [] },
      { worktree, fileSize: () => undefined },
    );
    expect(est.changedFiles).toEqual(['new.ts']);
    expect(est.estimatedTokens).toBe(4000);
  });

  it('is empty for an empty design', () => {
    expect(estimatePlanSize({ targetTypes: [], signatures: [] }, { worktree })).toEqual({
      changedFiles: [],
      testFiles: [],
      readFiles: [],
      estimatedTokens: 0,
    });
  });

  it('stats real files in the worktree by default', async () => {
    const tempDirs = createTempDirs();
    const dir = tempDirs.makeSync('size-est-');
    try {
      writeFileSync(join(dir, 'x.ts'), 'a'.repeat(40));
      const est = estimatePlanSize({ targetTypes: [t('x.ts'), t('missing.ts')], signatures: [] }, { worktree: dir });
      expect(est.estimatedTokens).toBe(10 + 2 * 4000);
    } finally {
      await tempDirs.cleanup();
    }
  });
});

describe('planOverBudget (#3350)', () => {
  const est = (files: number, tokens: number): PlanSizeEstimate => ({
    changedFiles: Array.from({ length: files }, (_, i) => `f${i}.ts`),
    testFiles: [],
    readFiles: [],
    estimatedTokens: tokens,
  });
  const budget = { tokenBudget: 1000, maxFiles: 6 };

  it('never splits a plan changing 3 or fewer files, even over the token budget', () => {
    expect(planOverBudget(est(3, 10_000_000), budget)).toBeNull();
    expect(planOverBudget(est(0, 10_000_000), budget)).toBeNull();
  });

  it('returns null at the boundary', () => {
    expect(planOverBudget(est(6, 1000), budget)).toBeNull();
  });

  it('names the estimate and the budget when over tokens', () => {
    const reason = planOverBudget(est(4, 1001), budget);
    expect(reason).toBe('plan estimate 1001 tokens (budget 1000), 4 changed files (max 6)');
  });

  it('splits when over maxFiles', () => {
    expect(planOverBudget(est(7, 1), budget)).toMatch(/7 changed files \(max 6\)/);
  });
});
