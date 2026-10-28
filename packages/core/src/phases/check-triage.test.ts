import { workKeyFromIssue } from '../work/work-key.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CheckerOutput, CheckSummary } from '../types/index.js';
import { checkPhase } from './check.js';

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

const PASS: CheckSummary = {
  failures: 0,
  passes: 1,
  skips: 0,
  total: 1,
  results: [{ checker: 'tests', result: 'PASS', details: '' }],
};
const failing = (...results: CheckerOutput[]): CheckSummary => ({
  failures: results.length,
  passes: 0,
  skips: 0,
  total: results.length,
  results,
});
const testsFail = (details: string, timedOut?: boolean): CheckerOutput => ({
  checker: 'tests',
  result: 'FAIL',
  details,
  ...(timedOut ? { timedOut } : {}),
});

async function run(summaries: CheckSummary[], maxReworkRounds = 1, evidence?: { sharedFailure?: string }) {
  const worktree = tempDirs.makeSync('check-triage-');
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  const specPath = join(worktree, 'issue-1.md');
  if (evidence) {
    const artifact = {
      restatedProblem: 'p',
      approach: { chosen: 'c', rejected: [] },
      interfacesTouched: [],
      targetTypes: [],
      signatures: [],
      callGraph: [],
      behaviorContract: ['b'],
      verificationPlan: [{ command: 'npm test', passWhen: 'passes' }],
      riskBlastRadius: 'r',
      openQuestions: [],
      evidencePlan: [{ kind: 'fail-to-pass-test', claim: 'c1', test: 't.test.ts' }],
    };
    await writeFile(specPath, `---\ndesign: ${JSON.stringify(artifact)}\n---\nSpec\n`);
  } else await writeFile(specPath, '# Spec: triage\n');
  let evidenceCalls = 0;
  let routerCalls = 0;
  let checkerCalls = 0;
  const logs: Array<{ type: string; msg: string }> = [];
  const router = {
    run: async () => {
      routerCalls++;
      return { model: 'fake', output: 'reworked', exitCode: 0, attempts: [] };
    },
  } as never;
  const result = await checkPhase({
    issue: workKeyFromIssue(1),
    worktree,
    specPath,
    router,
    constitution: null,
    log: (type, msg) => void logs.push({ type, msg }),
    maxReworkRounds,
    runCheckers: async () => summaries[Math.min(checkerCalls++, summaries.length - 1)]!,
    runEvidence: evidence
      ? async () => {
          evidenceCalls++;
          return [
            {
              claim: 'c1',
              kind: 'fail-to-pass-test',
              status: 'FAIL',
              reason: 'inconclusive',
              ...(evidence.sharedFailure ? { sharedFailure: evidence.sharedFailure } : {}),
            },
          ];
        }
      : ((async () => undefined) as never),
  });
  return {
    result,
    logs,
    routerCalls: () => routerCalls,
    checkerCalls: () => checkerCalls,
    evidenceCalls: () => evidenceCalls,
  };
}

describe('checkPhase infra triage (#3371)', () => {
  it('an infra-only checker failure re-runs once and never reaches rework (T08)', async () => {
    const r = await run([failing(testsFail('read ECONNRESET')), PASS]);
    expect(r.checkerCalls()).toBe(2);
    expect(r.routerCalls()).toBe(0);
    expect(r.result.passed).toBe(true);
    expect(r.result.reworkRounds).toBe(0);
    expect(r.logs.some((l) => l.type === 'check_triage')).toBe(true);
  });

  it('a missing-tool compile failure that passes on re-run passes CHECK with zero rework rounds', async () => {
    const compile: CheckerOutput = { checker: 'compile', result: 'FAIL', details: 'sh: tsc: command not found' };
    const r = await run([failing(compile), PASS]);
    expect(r.result.passed).toBe(true);
    expect(r.result.reworkRounds).toBe(0);
    expect(r.routerCalls()).toBe(0);
  });

  it('a repeated ECONNRESET returns infra with the matching line and no rework', async () => {
    const r = await run([failing(testsFail('read ECONNRESET'))]);
    expect(r.result.passed).toBe(false);
    expect(r.result.infra).toContain('read ECONNRESET');
    expect(r.routerCalls()).toBe(0);
    expect(r.checkerCalls()).toBe(2);
  });

  it('a repeated timeout goes to rework as on main', async () => {
    const r = await run([failing(testsFail('slow', true)), failing(testsFail('slow', true)), PASS]);
    expect(r.routerCalls()).toBe(1);
    expect(r.result.infra).toBeUndefined();
  });

  it('code failure goes straight to rework', async () => {
    const r = await run([failing(testsFail('AssertionError: expected 1 to be 2')), PASS]);
    expect(r.routerCalls()).toBe(1);
    expect(r.checkerCalls()).toBe(2);
    expect(r.logs.some((l) => l.type === 'check_triage')).toBe(false);
  });

  it('mixed infra and code failures rework without a triage re-run', async () => {
    const compile: CheckerOutput = { checker: 'compile', result: 'FAIL', details: 'TS2322' };
    const r = await run([failing(testsFail('read ECONNRESET'), compile), PASS]);
    expect(r.routerCalls()).toBe(1);
    expect(r.checkerCalls()).toBe(2);
    expect(r.logs.some((l) => l.type === 'check_triage')).toBe(false);
  });

  it('an evidence_plan fail-to-pass that fails identically on base and head parks check-infra with no router call (#3749)', async () => {
    const r = await run([PASS], 1, {
      sharedFailure: 'fail-to-pass t.test.ts failed identically on base and head (exit 1): Socket bind refused',
    });
    expect(r.routerCalls()).toBe(0);
    expect(r.result.reworkRounds).toBe(0);
    expect(r.result.passed).toBe(false);
    expect(r.result.infra).toContain('check-infra');
    expect(r.result.infra).toContain('evidence_plan');
    expect(r.result.infra).toContain('t.test.ts');
    expect(r.evidenceCalls()).toBe(2);
  });

  it('an evidence_plan fail-to-pass without sharedFailure reaches the router', async () => {
    const r = await run([PASS], 1, {});
    expect(r.routerCalls()).toBeGreaterThan(0);
    expect(r.result.infra).toBeUndefined();
  });
});
