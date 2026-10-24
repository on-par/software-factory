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

async function run(summaries: CheckSummary[], maxReworkRounds = 1) {
  const worktree = tempDirs.makeSync('check-triage-');
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  const specPath = join(worktree, 'issue-1.md');
  await writeFile(specPath, '# Spec: triage\n');
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
    issue: 1,
    worktree,
    specPath,
    router,
    constitution: null,
    log: (type, msg) => void logs.push({ type, msg }),
    maxReworkRounds,
    runCheckers: async () => summaries[Math.min(checkerCalls++, summaries.length - 1)]!,
    runEvidence: (async () => undefined) as never,
  });
  return { result, logs, routerCalls: () => routerCalls, checkerCalls: () => checkerCalls };
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
});
