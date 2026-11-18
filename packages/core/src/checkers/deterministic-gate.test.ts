import { describe, expect, it } from 'vitest';

import { describeDeterministicGate, detectDeterministicGate, uncoveredChangedLines } from './deterministic-gate.js';

const COVERAGE_LINE =
  'ERROR: Coverage for statements (96.87%) does not meet "packages/cli/src/**/*.{ts,tsx}" threshold (96.9%)';
const PASSING_RUN = ' Test Files  1087 passed | 1 skipped (1088)\n      Tests  13901 passed (13901)';

const COVERAGE_TABLE = [
  '-------------------|---------|----------|---------|---------|-------------------',
  'File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s ',
  '-------------------|---------|----------|---------|---------|-------------------',
  'All files          |   96.87 |    92.11 |   97.02 |   96.87 |                   ',
  ' packages/cli/src  |   95.12 |    90.00 |   96.00 |   95.12 |                   ',
  '  run.ts           |   80.00 |    75.00 |  100.00 |   80.00 | 12-15,30          ',
  '  untouched.ts     |   70.00 |    60.00 |   50.00 |   70.00 | 1-40              ',
  '  full.ts          |  100.00 |   100.00 |  100.00 |  100.00 |                   ',
  ' packages/core/src |   99.00 |    98.00 |   99.00 |   99.00 |                   ',
  '  run.ts           |   90.00 |    85.00 |  100.00 |   90.00 | 7                 ',
].join('\n');

describe('detectDeterministicGate (#4263)', () => {
  it('classifies a coverage-threshold miss with no failing tests', () => {
    expect(detectDeterministicGate(`${PASSING_RUN}\n${COVERAGE_LINE}`)).toEqual({
      kind: 'coverage threshold',
      lines: [COVERAGE_LINE],
    });
  });

  it('classifies a test-time budget failure', () => {
    const line =
      'test-budget: FAIL — test step took 900s, over the 600s budget (scripts/test-budget.ts). Failing verify because CI is set.';
    expect(detectDeterministicGate(`${PASSING_RUN}\n${line}`)).toEqual({ kind: 'test-time budget', lines: [line] });
  });

  it('classifies a LOC budget failure', () => {
    const line =
      'packages/core source is 120 lines, over its loc-budget.json budget of 100. Delete or reuse existing code before adding more.';
    expect(detectDeterministicGate(`> npm run loc-budget\n${line}`)).toEqual({ kind: 'loc budget', lines: [line] });
    expect(detectDeterministicGate('loc budget: head loc-budget.json must be a JSON object')?.kind).toBe('loc budget');
    expect(detectDeterministicGate('loc budget: PASS (4 packages)')).toBeNull();
  });

  it('returns null when a test failed, so the flake re-run still happens', () => {
    expect(detectDeterministicGate(` × suite > adds 3ms\n${COVERAGE_LINE}`)).toBeNull();
    expect(detectDeterministicGate(`      Tests  1 failed | 10 passed (11)\n${COVERAGE_LINE}`)).toBeNull();
  });

  it('returns null without a gate marker', () => {
    expect(detectDeterministicGate(PASSING_RUN)).toBeNull();
  });
});

describe('uncoveredChangedLines (#4263)', () => {
  it('lists uncovered lines only for changed files, matching on the full path', () => {
    expect(uncoveredChangedLines(COVERAGE_TABLE, ['packages/cli/src/run.ts', 'packages/cli/src/full.ts'])).toEqual([
      'packages/cli/src/run.ts: stmts 80.00%, branch 75.00%, funcs 100.00%, lines 80.00%; uncovered 12-15,30',
    ]);
  });

  it('resolves rows when the report root sits below the repo root', () => {
    const table = COVERAGE_TABLE.replaceAll(' packages/cli/src  ', ' cli/src           ');
    expect(uncoveredChangedLines(table, ['packages/cli/src/run.ts'])).toHaveLength(1);
  });

  it('returns nothing when there is no coverage table', () => {
    expect(uncoveredChangedLines(PASSING_RUN, ['packages/cli/src/run.ts'])).toEqual([]);
  });
});

describe('describeDeterministicGate (#4263)', () => {
  const coverage = { kind: 'coverage threshold' as const, lines: [COVERAGE_LINE] };

  it('includes the threshold lines and the uncovered rows', () => {
    const text = describeDeterministicGate(coverage, ['packages/cli/src/run.ts: lines 80%; uncovered 12-15']);
    expect(text).toContain('deterministic gate failed (coverage threshold)');
    expect(text).toContain(COVERAGE_LINE);
    expect(text).toContain('uncovered lines in changed files:\npackages/cli/src/run.ts: lines 80%; uncovered 12-15');
  });

  it('says when no changed file has uncovered lines or the diff is unavailable', () => {
    expect(describeDeterministicGate(coverage, [])).toContain('no uncovered lines found for changed files');
    expect(describeDeterministicGate(coverage, { unavailable: 'no base ref resolves' })).toContain(
      'uncovered lines in changed files unavailable: no base ref resolves',
    );
  });

  it('carries only the gate message for budget gates', () => {
    const text = describeDeterministicGate({ kind: 'test-time budget', lines: ['test-budget: FAIL — over'] }, []);
    expect(text).toBe(
      'deterministic gate failed (test-time budget); no test failed, so this is not a flake. Fix the gap:\ntest-budget: FAIL — over',
    );
  });
});
