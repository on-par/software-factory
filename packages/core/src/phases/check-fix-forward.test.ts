import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import type { CheckSummary } from '../types/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { baselineCandidates, checkPhase } from './check.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const BASE = 'abc1234567';
const reproduced = {
  command: ['npm', 'test'],
  stdout: '',
  stderr: '',
  exitCode: 1,
  killed: false,
  timedOut: false,
  ok: false,
};

const summaryOf = (...results: Array<[string, 'PASS' | 'FAIL']>): CheckSummary => ({
  results: results.map(([checker, result]) => ({
    checker,
    result,
    details: result === 'FAIL' ? ` × suite > ${checker} broke` : '',
  })),
  failures: results.filter(([, r]) => r === 'FAIL').length,
  passes: results.filter(([, r]) => r === 'PASS').length,
  skips: 0,
  total: results.length,
});

async function run(
  rounds: CheckSummary[],
  extra: { maxReworkRounds?: number; baseline?: BaselineReport['checkers'] } = {},
) {
  const worktree = await dirs.make('check-fix-forward-');
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const prompts: string[] = [];
  const router = {
    run: async (_task: string, prompt: string) => {
      prompts.push(prompt);
      return { model: 'fake', output: 'done', exitCode: 0, attempts: [] };
    },
  };
  let round = 0;
  const failingSeen: string[][] = [];
  const runBaseline = vi.fn(async (o: { baseSha: string; failing: ReadonlyArray<{ checker: string }> }) => {
    failingSeen.push(o.failing.map((r) => r.checker));
    return {
      baseSha: o.baseSha,
      checkers: extra.baseline ?? o.failing.map((r) => ({ checker: r.checker, verdict: 'fails-on-base' as const })),
    } as BaselineReport;
  });
  const result = await checkPhase({
    issue: workKeyFromIssue(4029),
    worktree,
    specPath: join(worktree, 'missing-spec.md'),
    router: router as never,
    constitution: null,
    diffBase: BASE,
    maxReworkRounds: extra.maxReworkRounds ?? 1,
    log: () => {},
    runCheckers: async () => rounds[Math.min(round++, rounds.length - 1)]!,
    runBaseline: runBaseline as never,
    runCommand: (async () => reproduced) as never,
  });
  return { result, runBaseline, failingSeen, prompts };
}

describe('baselineCandidates (#4029)', () => {
  it('keeps failing non-test checkers and drops tests, evidence_plan, side_effects and passes', () => {
    const s = summaryOf(
      ['tests', 'FAIL'],
      ['evidence_plan', 'FAIL'],
      ['side_effects', 'FAIL'],
      ['compile', 'FAIL'],
      ['lint', 'PASS'],
    );
    expect(baselineCandidates(s).map((r) => r.checker)).toEqual(['compile']);
  });
});

describe('checkPhase fixes tests forward (#4029)', () => {
  it('never runs a base baseline for the tests checker', async () => {
    const onlyTests = await run([summaryOf(['tests', 'FAIL'])], { maxReworkRounds: 0 });
    expect(onlyTests.runBaseline).not.toHaveBeenCalled();

    const both = await run([summaryOf(['tests', 'FAIL'], ['compile', 'FAIL'])], { maxReworkRounds: 0 });
    expect(both.runBaseline).toHaveBeenCalledTimes(1);
    expect(both.failingSeen[0]).toContain('compile');
    expect(both.failingSeen[0]).not.toContain('tests');
  });

  it('a tests failure that also fails on base goes to rework, not an environment release', async () => {
    const { result } = await run([summaryOf(['tests', 'FAIL'])], {
      baseline: [{ checker: 'tests', verdict: 'fails-on-base' }],
    });
    expect(result.environment).toBeUndefined();
    expect(result.reworkRounds).toBeGreaterThanOrEqual(1);
  });

  it('a tests failure is never dropped from the rework target as base-failing', async () => {
    const { prompts, result } = await run([
      summaryOf(['tests', 'FAIL'], ['compile', 'FAIL']),
      summaryOf(['tests', 'FAIL'], ['compile', 'FAIL']),
    ]);
    expect(result.reworkRounds).toBe(1);
    expect(prompts[0]).toContain('### tests');
    expect(prompts[0]).not.toContain('### compile');
  });

  it('a red-main tests failure fixed in rework ends CHECK green', async () => {
    const { result } = await run([summaryOf(['tests', 'FAIL']), summaryOf(['tests', 'PASS'])]);
    expect(result.passed).toBe(true);
    expect(result.reworkRounds).toBe(1);
    expect(result.flakeRerun?.verdict).toBe('reproduced');
  });
});
