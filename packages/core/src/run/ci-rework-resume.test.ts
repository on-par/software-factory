import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShipResult } from '../phases/ship.js';
import {
  BUILD_OK,
  buildPhase,
  CHECK_OK,
  checkPhase,
  type Log,
  PLAN_OK,
  planPhase,
  policy,
  ports,
  request,
  resetCiReworkMocks,
  reworkWorker,
  shipPhase,
  tmp,
} from './ci-rework-test-helpers.js';
import { reworkStopSuffix } from './ci-rework-resume.js';
import { runIssue } from './run-issue.js';
import type { RunStateUpdate } from './state.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);
afterEach(() => vi.unstubAllEnvs());

const PR = 7;

const failed = (headSha: string): ShipResult => ({
  ok: false,
  prNumber: PR,
  reason: `CI failed for PR #${PR}`,
  ciOutcome: 'failure',
  ciFailure: { failingChecks: [{ name: 'test (2/3)', conclusion: 'failure' }], alerts: [], truncated: false },
  headSha,
});

const GREEN: ShipResult = { ok: true, prNumber: PR, ciOutcome: 'success', headSha: 'h-green' };

async function resume(used: number, replies: ShipResult[]) {
  const steps: string[] = [];
  const ships: Array<{ reentry?: { prNumber: number; previousHeadSha?: string } }> = [];
  const rounds: Array<{ prNumber: number; round: number }> = [];
  const lines: string[] = [];
  planPhase.mockImplementation(async () => {
    steps.push('plan');
    return PLAN_OK;
  });
  buildPhase.mockImplementation(async () => {
    steps.push('build');
    return BUILD_OK;
  });
  checkPhase.mockImplementation(async () => {
    steps.push('check');
    return CHECK_OK;
  });
  reworkWorker.mockImplementation(async () => {
    steps.push('rework');
    return { failovers: [], modelCompleted: true };
  });
  shipPhase.mockImplementation(async (opts) => {
    steps.push('ship');
    ships.push({ reentry: opts.reentry });
    return replies.shift() ?? GREEN;
  });
  const log: Log = (type, message) => {
    lines.push(`${type}: ${message}`);
  };
  const recordRunState = (update: RunStateUpdate): void => {
    if (update.ciReworkRound) rounds.push(update.ciReworkRound);
  };
  const resumed = { ...request, ciReworkResume: { prNumber: PR, used } };
  const outcome = await runIssue(resumed, policy, { ...ports(log), recordRunState });
  return { outcome, steps, ships, rounds, lines };
}

describe('a CI rework resume runs one round on the open PR and returns to SHIP', () => {
  it('skips PLAN, BUILD and the first CHECK, records the next round and re-enters SHIP on the same PR', async () => {
    const run = await resume(1, [failed('h1')]);
    expect(run.outcome).toMatchObject({ state: 'ready', prNumber: PR });
    expect(run.steps).toEqual(['ship', 'rework', 'check', 'ship']);
    expect(run.rounds).toEqual([
      { prNumber: PR, round: 1 },
      { prNumber: PR, round: 2 },
    ]);
    expect(run.ships).toEqual([
      { reentry: { prNumber: PR, previousHeadSha: undefined } },
      { reentry: { prNumber: PR, previousHeadSha: 'h1' } },
    ]);
    expect(run.lines.join('\n')).toContain(`resuming at CI rework on PR #${PR}`);
    expect(run.lines.join('\n')).toContain('CI rework round 2/2');
  });

  it('stops after its one round when CI is still red and says the resume ran its round', async () => {
    const run = await resume(0, [failed('h1'), failed('h2')]);
    expect(run.outcome).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(run.steps).toEqual(['ship', 'rework', 'check', 'ship']);
    expect(run.rounds).toEqual([{ prNumber: PR, round: 1 }]);
    expect(run.lines.join('\n')).toContain('this resume ran its one CI rework round (1 of 2)');
  });

  it('starts no round when the recorded count already reached the configured cap', async () => {
    vi.stubEnv('FACTORY_MAX_CI_REWORK_ROUNDS', '1');
    const run = await resume(1, [failed('h1')]);
    expect(run.outcome).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(run.steps).toEqual(['ship']);
    expect(run.rounds).toEqual([{ prNumber: PR, round: 1 }]);
    expect(run.lines.join('\n')).toContain('CI rework budget exhausted after 1 round');
  });

  it('ends ready with no round when SHIP finds the PR green', async () => {
    const run = await resume(0, [GREEN]);
    expect(run.outcome).toMatchObject({ state: 'ready', prNumber: PR });
    expect(run.steps).toEqual(['ship']);
    expect(run.rounds).toEqual([]);
  });
});

describe('reworkStopSuffix', () => {
  it.each([
    ['CI', 1, 2, ' — this resume ran its one CI rework round (1 of 2)'],
    ['preview', 2, 2, ' — preview rework budget exhausted after 2 rounds'],
    ['CI', 1, 1, ' — CI rework budget exhausted after 1 round'],
  ])('%s after %i of %i', (kind, rounds, cap, expected) => {
    expect(reworkStopSuffix(kind, rounds, cap)).toBe(expected);
  });
});
