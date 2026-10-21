import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { collectRetainedHiddenValues, findLeakedValues } from './leak-guard.js';

describe('findLeakedValues', () => {
  it('returns [] when no hidden value appears in the rendered text', () => {
    const rendered = 'Nothing sensitive in here.';
    expect(findLeakedValues(rendered, { testNames: ['test_secret'], problemIds: ['secret-problem'] })).toEqual([]);
  });

  it('returns the leaked test name when one of hidden.testNames is a substring of rendered', () => {
    const rendered = 'Failing tests that must pass:\n\n- Core: test_secret_case';
    expect(findLeakedValues(rendered, { testNames: ['test_secret_case'], problemIds: [] })).toEqual([
      'test_secret_case',
    ]);
  });

  it('returns the leaked problem id when one of hidden.problemIds is a substring of rendered', () => {
    const rendered = '# SCBench secret-problem-id — checkpoint 1';
    expect(findLeakedValues(rendered, { testNames: [], problemIds: ['secret-problem-id'] })).toEqual([
      'secret-problem-id',
    ]);
  });

  it('returns all leaked values, in combined testNames-then-problemIds order, when more than one is present', () => {
    const rendered = 'test_a and test_b and problem-a and problem-b all appear here';
    const found = findLeakedValues(rendered, {
      testNames: ['test_a', 'test_b'],
      problemIds: ['problem-a', 'problem-b'],
    });
    expect(found).toEqual(['test_a', 'test_b', 'problem-a', 'problem-b']);
  });

  it('returns [] for empty testNames/problemIds arrays', () => {
    expect(findLeakedValues('anything at all', { testNames: [], problemIds: [] })).toEqual([]);
  });
});

describe('collectRetainedHiddenValues', () => {
  const temp = createTempDirs();
  afterEach(() => temp.cleanup());
  const tmp = (): string => temp.makeSync('leak-guard-');
  const evaluation = (tests?: Record<string, unknown>): string =>
    JSON.stringify({
      problem_name: 'p',
      checkpoint_name: '1',
      pass_counts: { Core: 1 },
      total_counts: { Core: 1 },
      pytest_exit_code: 0,
      infrastructure_failure: false,
      ...(tests ? { tests } : {}),
    });
  const config = (dir: string): string => {
    const path = join(dir, 'baseline.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readRealConfig()),
        problems: { resolvedFrom: 'x', smoke: 'prob-a', suite: ['prob-a', 'prob-b'] },
      }),
    );
    return path;
  };
  const readRealConfig = (): string =>
    readFileSync(
      fileURLToPath(new URL('../../../evals/scbench-baseline/baseline.config.json', import.meta.url)),
      'utf-8',
    );

  it('collects passed and failed test names from nested evaluation.json files and baseline problem ids', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    mkdirSync(join(dir, 'c'), { recursive: true });
    writeFileSync(
      join(dir, 'a/b/evaluation.json'),
      evaluation({ Core: { passed: ['t_one'], failed: ['t_two'], skipped: ['t_skip'] } }),
    );
    writeFileSync(
      join(dir, 'c/evaluation.json'),
      evaluation({ Reg: { passed: ['t_one', 't_three'], failed: [], skipped: [] } }),
    );
    const hidden = collectRetainedHiddenValues([dir], config(dir));
    expect(hidden.testNames).toEqual(['t_one', 't_three', 't_two']);
    expect(hidden.problemIds).toEqual(['prob-a', 'prob-b']);
  });

  it('skips a missing root and an evaluation.json without tests', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'evaluation.json'), evaluation());
    const hidden = collectRetainedHiddenValues([join(dir, 'missing'), dir], config(dir));
    expect(hidden.testNames).toEqual([]);
    expect(hidden.problemIds).toEqual(['prob-a', 'prob-b']);
  });
});
