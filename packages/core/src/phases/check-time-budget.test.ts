import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import type { RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { createPhaseTestSetup, stubModel, stubModelsConfig } from '../test-support/index.js';
import type { CheckSummary } from '../types/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { checkPhase } from './check.js';
import {
  createTimeBudget,
  describeTimeBudgetSkip,
  parseRunDeadline,
  timeBudgetParkMessage,
} from './check-time-budget.js';

const MIN = 60_000;
const START = Date.parse('2026-11-18T00:29:00.000Z');

describe('parseRunDeadline (#4264)', () => {
  it('reads epoch ms and ISO-8601, and ignores blank or junk values', () => {
    expect(parseRunDeadline('1790000000000')).toBe(1_790_000_000_000);
    expect(parseRunDeadline(' 2026-11-18T01:50:00Z ')).toBe(Date.parse('2026-11-18T01:50:00Z'));
    expect(parseRunDeadline(undefined)).toBeUndefined();
    expect(parseRunDeadline('  ')).toBeUndefined();
    expect(parseRunDeadline('soon')).toBeUndefined();
  });
});

describe('createTimeBudget (#4264)', () => {
  it('always fits without a deadline', () => {
    const budget = createTimeBudget({ deadlineAtMs: undefined, now: () => START });
    expect(budget.fit('rework')).toEqual({ fits: true, neededMs: 0, leftMs: Infinity });
  });

  it('uses the defaults until a verify is measured, then the slowest measured verify', () => {
    let now = START;
    const budget = createTimeBudget({ deadlineAtMs: START + 30 * MIN, now: () => now });
    expect(budget.fit('rerun')).toEqual({ fits: true, neededMs: 12 * MIN, leftMs: 30 * MIN });
    expect(budget.fit('rework')).toEqual({ fits: true, neededMs: 22 * MIN, leftMs: 30 * MIN });
    budget.recordVerify(8 * MIN);
    budget.recordVerify(3 * MIN);
    now = START + 11 * MIN;
    expect(budget.fit('rerun')).toEqual({ fits: true, neededMs: 10 * MIN, leftMs: 19 * MIN });
    expect(budget.fit('rework')).toEqual({ fits: false, neededMs: 20 * MIN, leftMs: 19 * MIN });
  });

  it('honours configured estimates', () => {
    const budget = createTimeBudget({
      deadlineAtMs: START + 10 * MIN,
      now: () => START,
      settings: { verifyMinutes: 4, reworkBuildMinutes: 5, safetyMarginMinutes: 0 },
    });
    expect(budget.fit('rerun').neededMs).toBe(4 * MIN);
    expect(budget.fit('rework')).toMatchObject({ fits: true, neededMs: 9 * MIN });
  });

  it('never fits once the run is asked to stop (#4269)', () => {
    const budget = createTimeBudget({ deadlineAtMs: undefined, now: () => START, stopRequested: () => true });
    const fit = budget.fit('rerun');
    expect(fit).toEqual({ fits: false, neededMs: 0, leftMs: 0, stopped: true });
    expect(describeTimeBudgetSkip('rerun', fit)).toBe('skipped rerun — the run was asked to stop');
  });

  it('describes the skip and keeps the real failure in the park message', () => {
    const fit = { fits: false, neededMs: 19.5 * MIN, leftMs: 3.8 * MIN };
    expect(describeTimeBudgetSkip('rework', fit)).toBe('skipped rework — needs ~20m, 3m left in the run budget');
    expect(describeTimeBudgetSkip('rerun', { fits: false, neededMs: MIN, leftMs: -MIN })).toBe(
      'skipped rerun — needs ~1m, 0m left in the run budget',
    );
    const summary: CheckSummary = {
      failures: 1,
      passes: 1,
      skips: 0,
      total: 2,
      results: [
        { checker: 'tests', result: 'FAIL', details: 'coverage 96.87% < 96.9%' },
        { checker: 'lint', result: 'PASS', details: 'ok' },
      ],
    };
    expect(timeBudgetParkMessage('rework', fit, summary)).toBe(
      'time budget: skipped rework — needs ~20m, 3m left in the run budget; parking with the real check failure\ntests: coverage 96.87% < 96.9%',
    );
  });
});

describe('checkPhase run deadline (#4264)', () => {
  const setup = createPhaseTestSetup();
  afterEach(() => setup.cleanup());

  const models = stubModelsConfig({ 'stub-model': stubModel({ provider: 'openai' }) }, { boss: ['stub-model'] });
  const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'stub' } } };
  const failing: CheckSummary = {
    results: [{ checker: 'tests', result: 'FAIL', details: ' × suite > adds' }],
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
  };
  const reproduced = {
    command: ['npm', 'test'],
    stdout: '',
    stderr: '',
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
  };

  const run = async (deadlineAfterFirstVerifyMin: number | undefined, maxReworkRounds = 1) => {
    const worktree = await setup.worktree('check-time-budget-');
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const router = new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'rework done' }));
    let now = START;
    let verifies = 0;
    let reruns = 0;
    const logs: string[] = [];
    const result = await checkPhase({
      issue: workKeyFromIssue(4264),
      worktree,
      specPath: join(worktree, 'spec.md'),
      router,
      constitution: null,
      diffBase: 'abc1234567',
      maxReworkRounds,
      now: () => now,
      ...(deadlineAfterFirstVerifyMin === undefined
        ? {}
        : { runDeadlineAtMs: START + 8 * MIN + deadlineAfterFirstVerifyMin * MIN }),
      log: (_t, msg) => {
        logs.push(msg);
      },
      runCheckers: async () => {
        verifies++;
        now += 8 * MIN;
        return failing;
      },
      runBaseline: async (o) => ({ baseSha: o.baseSha, checkers: [] }) as BaselineReport,
      runCommand: (async () => {
        reruns++;
        now += MIN;
        return reproduced;
      }) as never,
    });
    return { result, logs, verifies, reruns };
  };

  it('with no deadline, re-runs and reworks as today', async () => {
    const { result, verifies, reruns } = await run(undefined);
    expect(reruns).toBe(1);
    expect(verifies).toBe(2);
    expect(result.reworkRounds).toBe(1);
    expect(result.timeBudget).toBeUndefined();
  });

  it('skips the flake re-run and parks time-budget when less than one verify is left', async () => {
    const { result, logs, verifies, reruns } = await run(5);
    expect(reruns).toBe(0);
    expect(verifies).toBe(1);
    expect(result.reworkRounds).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.flakeRerun).toBeUndefined();
    expect(logs).toContain('skipped rerun — needs ~10m, 5m left in the run budget');
    expect(result.timeBudget).toContain('time budget: skipped rerun — needs ~10m, 5m left in the run budget');
    expect(result.timeBudget).toContain('tests:  × suite > adds');
    expect(result.failureSignature).toBeDefined();
  });

  it('re-runs but does not start rework when rework plus verify will not fit', async () => {
    const { result, logs, verifies, reruns } = await run(15);
    expect(reruns).toBe(1);
    expect(verifies).toBe(1);
    expect(result.flakeRerun?.verdict).toBe('reproduced');
    expect(result.reworkRounds).toBe(0);
    expect(logs).toContain('skipped rework — needs ~20m, 14m left in the run budget');
    expect(result.timeBudget).toContain('skipped rework');
    expect(result.timeBudget).toContain('tests:  × suite > adds');
  });

  it('re-runs and reworks when enough time is left', async () => {
    const { result, logs, verifies, reruns } = await run(40);
    expect(reruns).toBe(1);
    expect(verifies).toBe(2);
    expect(result.reworkRounds).toBe(1);
    expect(result.timeBudget).toBeUndefined();
    expect(logs.some((l) => l.startsWith('skipped'))).toBe(false);
  });

  it('stops before a second rework round that no longer fits', async () => {
    const { result, logs, verifies } = await run(25, 2);
    expect(verifies).toBe(2);
    expect(result.reworkRounds).toBe(1);
    expect(logs).toContain('skipped rework — needs ~20m, 16m left in the run budget');
    expect(result.timeBudget).toContain('skipped rework');
  });
});
