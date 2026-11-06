import type { RunOutcome } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import type { MergeResult } from './run-issue-merge.js';
import {
  exitForUntilDone,
  runUntilDone,
  UNTIL_DONE_EXIT,
  type IssuePr,
  type UntilDoneDeps,
  type UntilDoneInput,
  type UntilDoneResult,
} from './run-until-done.js';

function readyOutcome(prNumber: number): RunOutcome {
  return { state: 'ready', route: 'claude', branch: 'factory/12-x', reworkRounds: 0, prNumber };
}

const openPr: IssuePr = { number: 7, branch: 'factory/12-x', state: 'open' };

function makeDeps(overrides: Partial<UntilDoneDeps> = {}) {
  let t = 0;
  return {
    findIssuePr: vi.fn<UntilDoneDeps['findIssuePr']>(overrides.findIssuePr ?? (async () => undefined)),
    prState: vi.fn<UntilDoneDeps['prState']>(overrides.prState ?? (async () => 'open')),
    ship: vi.fn<UntilDoneDeps['ship']>(overrides.ship ?? (async () => readyOutcome(7))),
    driveToMerge: vi.fn<UntilDoneDeps['driveToMerge']>(
      overrides.driveToMerge ?? (async () => ({ kind: 'merged', prNumber: 7, detail: 'merged' })),
    ),
    restorePrState: vi.fn<UntilDoneDeps['restorePrState']>(overrides.restorePrState ?? (async () => {})),
    pendingFeedback: vi.fn<UntilDoneDeps['pendingFeedback']>(overrides.pendingFeedback ?? (async () => 0)),
    feedbackRound: vi.fn<UntilDoneDeps['feedbackRound']>(
      overrides.feedbackRound ?? (async () => ({ parked: false, detail: 'shipped' })),
    ),
    saveAwaitingReview: vi.fn<UntilDoneDeps['saveAwaitingReview']>(overrides.saveAwaitingReview ?? (async () => {})),
    now: vi.fn<UntilDoneDeps['now']>(overrides.now ?? (() => t)),
    sleep: vi.fn<UntilDoneDeps['sleep']>(
      overrides.sleep ??
        (async (ms) => {
          t += ms;
        }),
    ),
    pollMs: overrides.pollMs ?? 1000,
    log: vi.fn<UntilDoneDeps['log']>(overrides.log),
  };
}

const input = (over: Partial<UntilDoneInput> = {}): UntilDoneInput => ({
  issue: 12,
  wait: 'stay',
  maxWaitMs: undefined,
  autoMerge: false,
  admin: false,
  mergeTimeoutMs: 60_000,
  ...over,
});

/** A fake GitHub PR timeline: each prState call returns the next state, then the last one repeats. */
function timeline(states: IssuePr['state'][]): UntilDoneDeps['prState'] {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)] ?? 'open';
}

describe('runUntilDone', () => {
  it('auto-merge ships, drives to merge and returns merged', async () => {
    const deps = makeDeps();
    const r = await runUntilDone(input({ autoMerge: true }), deps);
    expect(r).toMatchObject({ outcome: 'merged', prNumber: 7, rounds: 0 });
    expect(deps.ship).toHaveBeenCalledWith(12);
    expect(deps.driveToMerge).toHaveBeenCalledWith(readyOutcome(7));
  });

  it('a merge held by a gate is not merged and waits for review', async () => {
    const held: MergeResult = { kind: 'held', gate: 'risk', prNumber: 7, detail: 'high risk' };
    const deps = makeDeps({
      driveToMerge: vi.fn<UntilDoneDeps['driveToMerge']>(async () => held),
      prState: timeline(['open', 'merged']),
    });
    const r = await runUntilDone(input({ autoMerge: true }), deps);
    expect(r).toMatchObject({ outcome: 'merged', prNumber: 7 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('held by risk'));
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('auto false never drives to merge', async () => {
    const deps = makeDeps({ prState: timeline(['merged']) });
    await runUntilDone(input({ autoMerge: false }), deps);
    expect(deps.driveToMerge).not.toHaveBeenCalled();
  });

  it('a merge that fails parks with the kind and detail', async () => {
    const deps = makeDeps({
      driveToMerge: vi.fn<UntilDoneDeps['driveToMerge']>(async () => ({ kind: 'ci-failed', detail: 'red' })),
    });
    await expect(runUntilDone(input({ autoMerge: true }), deps)).resolves.toMatchObject({
      outcome: 'parked',
      detail: 'ci-failed: red',
    });
  });

  it('stay runs one feedback round then waits until the PR is merged', async () => {
    let pending = 1;
    const deps = makeDeps({
      prState: timeline(['open', 'open', 'merged']),
      pendingFeedback: vi.fn<UntilDoneDeps['pendingFeedback']>(async () => pending),
      feedbackRound: vi.fn<UntilDoneDeps['feedbackRound']>(async () => {
        pending = 0;
        return { parked: false, detail: 'shipped' };
      }),
    });
    const r = await runUntilDone(input(), deps);
    expect(r).toMatchObject({ outcome: 'merged', prNumber: 7, rounds: 1 });
    expect(deps.feedbackRound).toHaveBeenCalledTimes(1);
    expect(deps.feedbackRound).toHaveBeenCalledWith(7);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('auto-merge drives to merge again after a feedback round', async () => {
    let pending = 1;
    const held: MergeResult = { kind: 'held', gate: 'needs-human', detail: 'label' };
    const deps = makeDeps({
      pendingFeedback: vi.fn<UntilDoneDeps['pendingFeedback']>(async () => pending),
      feedbackRound: vi.fn<UntilDoneDeps['feedbackRound']>(async () => {
        pending = 0;
        return { parked: false, detail: 'shipped' };
      }),
    });
    deps.driveToMerge.mockResolvedValueOnce(held);
    const r = await runUntilDone(input({ autoMerge: true }), deps);
    expect(r).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(deps.driveToMerge).toHaveBeenCalledTimes(2);
  });

  it('stay returns awaiting-review when max-wait elapses', async () => {
    const deps = makeDeps();
    const r = await runUntilDone(input({ maxWaitMs: 2500 }), deps);
    expect(r).toMatchObject({ outcome: 'awaiting-review', prNumber: 7 });
    expect(deps.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 500]);
    expect(deps.saveAwaitingReview).toHaveBeenCalledWith(12, 7);
  });

  it('exit returns awaiting-review and saves PR run state when no feedback is pending', async () => {
    const deps = makeDeps();
    const r = await runUntilDone(input({ wait: 'exit' }), deps);
    expect(r).toMatchObject({ outcome: 'awaiting-review', prNumber: 7 });
    expect(deps.saveAwaitingReview).toHaveBeenCalledWith(12, 7);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('re-run with an open PR and no feedback never ships', async () => {
    const deps = makeDeps({ findIssuePr: vi.fn<UntilDoneDeps['findIssuePr']>(async () => openPr) });
    const r = await runUntilDone(input({ wait: 'exit' }), deps);
    expect(r.outcome).toBe('awaiting-review');
    expect(deps.ship).not.toHaveBeenCalled();
    expect(deps.restorePrState).toHaveBeenCalledWith(12, 'factory/12-x');
    expect(deps.feedbackRound).not.toHaveBeenCalled();
  });

  it('re-run with new feedback restores PR state and runs one round on the same PR', async () => {
    let pending = 2;
    const deps = makeDeps({
      findIssuePr: vi.fn<UntilDoneDeps['findIssuePr']>(async () => openPr),
      pendingFeedback: vi.fn<UntilDoneDeps['pendingFeedback']>(async () => pending),
      feedbackRound: vi.fn<UntilDoneDeps['feedbackRound']>(async () => {
        pending = 0;
        return { parked: false, detail: 'shipped' };
      }),
    });
    const r = await runUntilDone(input({ wait: 'exit' }), deps);
    expect(r).toMatchObject({ outcome: 'awaiting-review', prNumber: 7, rounds: 1 });
    expect(deps.ship).not.toHaveBeenCalled();
    expect(deps.restorePrState).toHaveBeenCalledBefore(deps.feedbackRound);
    expect(deps.feedbackRound).toHaveBeenCalledTimes(1);
    expect(deps.feedbackRound).toHaveBeenCalledWith(7);
  });

  it('closed PR returns closed', async () => {
    const found = vi.fn<UntilDoneDeps['findIssuePr']>(async () => ({ ...openPr, state: 'closed' }));
    const deps = makeDeps({ findIssuePr: found });
    await expect(runUntilDone(input(), deps)).resolves.toMatchObject({ outcome: 'closed', prNumber: 7 });
    expect(deps.ship).not.toHaveBeenCalled();
  });

  it('a PR closed while waiting returns closed', async () => {
    const deps = makeDeps({ prState: timeline(['closed']) });
    await expect(runUntilDone(input(), deps)).resolves.toMatchObject({ outcome: 'closed', prNumber: 7 });
  });

  it('an already merged PR returns merged without shipping', async () => {
    const found = vi.fn<UntilDoneDeps['findIssuePr']>(async () => ({ ...openPr, state: 'merged' }));
    const deps = makeDeps({ findIssuePr: found });
    await expect(runUntilDone(input(), deps)).resolves.toMatchObject({ outcome: 'merged', prNumber: 7 });
    expect(deps.ship).not.toHaveBeenCalled();
    expect(deps.driveToMerge).not.toHaveBeenCalled();
  });

  it.each<[string, RunOutcome | undefined, string]>([
    ['parked', { state: 'parked', reason: 'fail' }, 'parked: fail'],
    ['escalated', { state: 'escalated', reason: 'too big' }, 'escalated: too big'],
    ['no outcome', undefined, 'the run produced no outcome'],
    [
      'no PR',
      { state: 'ready', route: 'claude', branch: 'b', reworkRounds: 0 },
      'the run stopped before SHIP: no PR was opened',
    ],
  ])('ship park returns parked (%s)', async (_name, outcome, detail) => {
    const deps = makeDeps({ ship: vi.fn<UntilDoneDeps['ship']>(async () => outcome) });
    await expect(runUntilDone(input({ autoMerge: true }), deps)).resolves.toMatchObject({ outcome: 'parked', detail });
    expect(deps.driveToMerge).not.toHaveBeenCalled();
  });

  it('review-rework cap returns parked', async () => {
    const deps = makeDeps({
      pendingFeedback: vi.fn<UntilDoneDeps['pendingFeedback']>(async () => 1),
      feedbackRound: vi.fn<UntilDoneDeps['feedbackRound']>(async () => ({ parked: true, detail: 'at the cap' })),
    });
    await expect(runUntilDone(input(), deps)).resolves.toMatchObject({
      outcome: 'parked',
      detail: 'at the cap',
      prNumber: 7,
      rounds: 1,
    });
  });
});

describe('exitForUntilDone', () => {
  const result = (outcome: UntilDoneResult['outcome']): UntilDoneResult => ({
    outcome,
    prNumber: 7,
    detail: 'why',
    rounds: 0,
  });
  const codeOf = (outcome: UntilDoneResult['outcome']): number | undefined => {
    try {
      exitForUntilDone(result(outcome), 12);
    } catch (err) {
      return err instanceof CliExitError ? err.code : undefined;
    }
    return undefined;
  };

  it('exitForUntilDone maps merged to exit 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => exitForUntilDone(result('merged'), 12)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('merged PR #7'));
    log.mockRestore();
  });

  it('exitForUntilDone maps awaiting-review to exit 16', () => {
    expect(codeOf('awaiting-review')).toBe(16);
    expect(() => exitForUntilDone(result('awaiting-review'), 12)).toThrow(/awaiting-review \(PR #7\): why/);
  });

  it('exit codes are distinct per outcome', () => {
    const codes = [
      UNTIL_DONE_EXIT.merged,
      UNTIL_DONE_EXIT.parked,
      UNTIL_DONE_EXIT.closed,
      UNTIL_DONE_EXIT.awaitingReview,
    ];
    expect(new Set(codes).size).toBe(4);
    expect(codeOf('parked')).toBe(1);
    expect(codeOf('closed')).toBe(15);
    for (const code of codes) expect(code < 10 || code > 14).toBe(true);
  });
});
