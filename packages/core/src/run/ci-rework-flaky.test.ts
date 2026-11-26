import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { shipPhase as realShipPhase } from '../phases/ship.js';
import {
  FLAKY_BASE,
  FLAKY_CHECK,
  FLAKY_HEAD,
  FLAKY_RERUN_ARGV,
  flakyCiRig,
  type FlakyCiRigOptions,
} from '../test-support/ship-ci-flaky-rig.js';
import {
  listBaseFailingChecks,
  policy,
  ports,
  request,
  resetCiReworkMocks,
  tmp,
  type Log,
} from './ci-rework-test-helpers.js';
import { runIssue, type RunPorts } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

function runRig(opts: FlakyCiRigOptions) {
  const ci = flakyCiRig(opts);
  const events: Array<[string, string]> = [];
  const ships: string[] = [];
  const reworks: string[] = [];
  const log = vi.fn<Log>((type, msg) => {
    events.push([type, msg]);
  });
  const shipPhase = vi.fn<typeof realShipPhase>(async (o) => {
    ships.push(o.reentry ? 'reentry' : 'first');
    if (o.reentry) return { ok: true, prNumber: 9 };
    const watched = await ci.watch(o.log);
    return watched.result ?? { ok: true, prNumber: 9 };
  });
  const reworkWorker = vi.fn<NonNullable<RunPorts['reworkWorker']>>(async (o) => {
    reworks.push(o.extraInstructions ?? '');
    return { failovers: [], modelCompleted: true };
  });
  listBaseFailingChecks.mockResolvedValue({
    baseRef: 'main',
    baseSha: FLAKY_BASE,
    failing: opts.base === 'failing' ? [FLAKY_CHECK] : [],
    passing: opts.base === 'passing' ? ['test', FLAKY_CHECK] : ['test'],
  });
  const rigged: RunPorts = { ...ports(log), shipPhase, reworkWorker };
  return { rigged, events, ships, reworks, reruns: ci.reruns };
}

describe('shipWithCiRework — a failing check with no result on the base commit (#4337)', () => {
  it.each([
    {
      label: 'a green rerun ships with no rework round',
      opts: { base: 'none' as const, outcomes: ['failure' as const, 'success' as const] },
      state: { state: 'ready' },
      reworks: 0,
      reruns: [FLAKY_RERUN_ARGV],
      ships: ['first'],
      eventKind: 'ci-flaky-rerun-green',
    },
    {
      label: 'a still-red rerun parks ci-flaky with no rework round',
      opts: { base: 'none' as const, outcomes: ['failure' as const, 'failure' as const] },
      state: { state: 'parked', reason: 'ci-flaky', prNumber: 9 },
      reworks: 0,
      reruns: [FLAKY_RERUN_ARGV],
      ships: ['first'],
      eventKind: 'ci-flaky',
    },
    {
      label: 'a check that passes on base still goes to rework without a rerun',
      opts: { base: 'passing' as const, outcomes: ['failure' as const] },
      state: { state: 'ready' },
      reworks: 1,
      reruns: [],
      ships: ['first', 'reentry'],
      eventKind: undefined,
    },
    {
      label: 'a spent shared rerun budget falls back to rework without a rerun',
      opts: { base: 'none' as const, outcomes: ['failure' as const], budget: new Set([FLAKY_HEAD]) },
      state: { state: 'ready' },
      reworks: 1,
      reruns: [],
      ships: ['first', 'reentry'],
      eventKind: undefined,
    },
  ])('$label', async (row) => {
    const { rigged, events, ships, reworks, reruns } = runRig(row.opts);
    expect(await runIssue(request, policy, rigged)).toMatchObject(row.state);
    expect(reworks).toHaveLength(row.reworks);
    expect(reruns).toEqual(row.reruns);
    expect(ships).toEqual(row.ships);
    const flakyKinds = events.map(([type]) => type).filter((type) => type.startsWith('ci-flaky'));
    expect(flakyKinds).toEqual(row.eventKind ? [row.eventKind] : []);
    expect(events.some(([type]) => type === 'ci-failed')).toBe(false);
  });

  it('names the check, the empty base result and the one rerun in the ci-flaky park message', async () => {
    const { rigged, events } = runRig({ base: 'none', outcomes: ['failure', 'failure'] });
    await runIssue(request, policy, rigged);
    const parked = events.filter(([type]) => type === 'ci-flaky').map(([, msg]) => msg);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toContain(
      `ship phase failed: CI failed for PR #9: check(s) ${FLAKY_CHECK} had no result on base main@${'b'.repeat(12)} and still failed after one rerun`,
    );
  });
});
