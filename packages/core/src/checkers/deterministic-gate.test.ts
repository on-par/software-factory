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

describe('detectDeterministicGate format, lint and typecheck (#4290)', () => {
  it('detects a format-only failure', () => {
    const lines = [
      '[warn] src/a.ts',
      '[warn] src/b.ts',
      '[warn] Code style issues found in 2 files. Run Prettier with --write to fix.',
    ];
    expect(detectDeterministicGate(`${PASSING_RUN}\n${lines.join('\n')}`)).toEqual({ kind: 'format', lines });
    expect(detectDeterministicGate(`${PASSING_RUN}\nCode style issues found in 2 files`)?.kind).toBe('format');
    expect(detectDeterministicGate(`${COVERAGE_LINE}\nCode style issues found in 2 files`)?.kind).toBe(
      'coverage threshold',
    );
  });

  it('detects lint and typecheck failures', () => {
    const oxlint =
      "  × eslint(no-unused-vars): Variable 'x' is declared but never used.\nFound 0 warnings and 3 errors.";
    const gate = detectDeterministicGate(`${PASSING_RUN}\n${oxlint}`);
    expect(gate?.kind).toBe('lint');
    expect(gate?.lines).toContain('Found 0 warnings and 3 errors.');
    expect(detectDeterministicGate(`${PASSING_RUN}\n✖ 3 problems (2 errors, 1 warning)`)?.kind).toBe('lint');
    expect(detectDeterministicGate('> oxlint --deny-warnings\nFound 2 warnings and 0 errors.')?.kind).toBe('lint');
    const a = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const b = "src/b.ts:1:1 - error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(detectDeterministicGate(`${PASSING_RUN}\n${a}\n${b}`)).toEqual({ kind: 'typecheck', lines: [a, b] });
  });

  it('a failing test keeps the re-run', () => {
    const summary = 'Code style issues found in 2 files';
    expect(detectDeterministicGate(`${summary}\n × suite > adds 3ms`)).toBeNull();
    expect(detectDeterministicGate(`${summary}\n      Tests  1 failed | 10 passed (11)`)).toBeNull();
    expect(detectDeterministicGate('Found 2 warnings and 0 errors.')).toBeNull();
    expect(detectDeterministicGate('Found 0 warnings and 0 errors.')).toBeNull();
    expect(detectDeterministicGate('[warn] something')).toBeNull();
  });
});
