import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { countLines, measurePackages, runLocBudget, type LocBudgetIo } from './loc-budget.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fakeRepo(): string {
  const root = tempDirs.makeSync('loc-budget-');
  write(root, 'packages/a/package.json', '{}');
  write(root, 'packages/a/src/x.ts', 'a\nb\nc\n');
  write(root, 'packages/a/src/x.test.ts', 'a\nb\n');
  write(root, 'packages/a/node_modules/y.ts', 'a\nb\nc\nd\n');
  write(root, 'packages/a/dist/z.ts', 'a\nb\nc\nd\n');
  write(root, 'packages/notpkg/src/q.ts', 'a\n');
  return root;
}

function budgetJson(source: number, tests = 2): string {
  return JSON.stringify({ a: { source, tests } });
}

function run(
  argv: string[],
  root: string,
  extra: Partial<LocBudgetIo> = {},
): { code: number; out: string; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = runLocBudget(argv, {
    cwd: root,
    log: (l) => lines.push(l),
    error: (l) => {
      lines.push(l);
      errors.push(l);
    },
    ...extra,
  });
  return { code, out: lines.join('\n'), errors };
}

function check(source: number): { code: number; out: string } {
  const root = fakeRepo();
  write(root, 'loc-budget.json', budgetJson(source));
  return run([], root);
}

describe('loc-budget', () => {
  it('counts lines like max-lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\n\nb')).toBe(3);
    expect(countLines('// c\n\n')).toBe(2);
  });

  it('measures source and tests per package, skipping node_modules, dist and non-packages', () => {
    expect(measurePackages(fakeRepo())).toEqual({ a: { source: 3, tests: 2 } });
  });

  it('passes when counts equal the budget', () => {
    const result = check(3);
    expect(result.code).toBe(0);
    expect(result.out).toContain('loc budget: PASS');
  });

  it('fails an over-budget package', () => {
    const result = check(2);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Delete or reuse existing code before adding more');
    expect(result.out).toContain('set "a".source to 3 in loc-budget.json');
  });

  it('fails an under-budget package and names the number to lower it to', () => {
    const result = check(5);
    expect(result.code).toBe(1);
    expect(result.out).toContain('lower "a".source to 3');
  });

  it('passes once the recorded number is lowered in the same PR', () => {
    expect(check(3).code).toBe(0);
  });

  it('fails a missing or stale package entry', () => {
    const root = fakeRepo();
    write(root, 'loc-budget.json', '{}');
    const missing = run([], root);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('packages/a has no loc-budget.json entry');
    write(root, 'loc-budget.json', JSON.stringify({ a: { source: 3, tests: 2 }, gone: { source: 1, tests: 1 } }));
    const stale = run([], root);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('entry for packages/gone, which does not exist');
  });

  it('rejects bad usage and malformed budgets', () => {
    const root = fakeRepo();
    expect(run(['--bogus'], root).code).toBe(2);
    expect(run(['--base', 'abc', '--pr', '7'], root).code).toBe(2);
    write(root, 'loc-budget.json', '[]');
    expect(run([], root).code).toBe(1);
    write(root, 'loc-budget.json', budgetJson(-1));
    const negative = run([], root);
    expect(negative.code).toBe(1);
    expect(negative.out).toContain('entry a must be {source, tests} non-negative integers');
  });
});
