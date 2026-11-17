import { describe, expect, it } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';
import { watchChecks, watchChecksWithInfraRerun } from './ci-watch.js';

function scriptChecks(sequence: any[][]) {
  let i = 0;
  const listForRef = async (_args: any) => {
    const runs = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { data: { check_runs: runs } };
  };
  return { listForRef, callCount: () => i };
}

function createClock() {
  let clock = 0;
  const now = () => clock;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { now, sleep, sleeps };
}

const countingStatus = (total: number) =>
  recordArgs(async () => ({ data: { total_count: total, statuses: total ? [{}] : [], sha: 'abc123' } }));

const pending = [{ status: 'in_progress', conclusion: null }];

describe('watchChecks no-checks early exit and progress (#2386)', () => {
  const base = { owner: 'on-par', repo: 'software-factory', ref: 'ship-it/123-ci-poll' };

  it('returns no-checks after the grace period when there are no check runs and no commit statuses', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const { calls, fn: getCombinedStatusForRef } = recordArgs(async () => {
      expect(now()).toBeGreaterThanOrEqual(90_000);
      return { data: { total_count: 0, statuses: [], sha: 'abc123' } };
    });
    const noChecks: unknown[] = [];
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({
      ...base,
      octokit: octokit as any,
      noChecksGraceMs: 90_000,
      onNoChecks: (i) => void noChecks.push(i),
      sleep,
      now,
    });

    expect(outcome).toBe('no-checks');
    expect(noChecks).toEqual([expect.objectContaining({ sha: 'abc123', reason: 'grace-elapsed' })]);
    expect(now()).toBeGreaterThanOrEqual(90_000);
    expect(now()).toBeLessThanOrEqual(90_000 + 60_000);
    expect(calls).toHaveLength(1);
  });

  it('keeps watching when commit statuses exist even with zero check runs', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const { calls: reads, fn: getCombinedStatusForRef } = countingStatus(1);
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('keeps watching when the combined-status call throws', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const { calls, fn: getCombinedStatusForRef } = recordArgs(async () => {
      throw new Error('boom');
    });
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(now()).toBeGreaterThanOrEqual(600_000);
    expect(calls.length).toBeGreaterThan(3);
  });

  it('never checks statuses or returns no-checks when noChecksGraceMs is unset', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const { calls: reads, fn: getCombinedStatusForRef } = countingStatus(0);
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, sleep, now });

    expect(outcome).toBe('timeout');
    expect(reads).toEqual([]);
  });

  it('reports progress at most once per progressIntervalMs with remaining time while checks are pending', async () => {
    const { listForRef } = scriptChecks([pending]);
    const { now, sleep } = createClock();
    const octokit = { rest: { checks: { listForRef } } };
    const seen: Array<{ total: number; completed: number; pending: number; elapsedMs: number; remainingMs: number }> =
      [];

    const outcome = await watchChecks({
      ...base,
      octokit: octokit as any,
      onProgress: (p) => seen.push(p),
      sleep,
      now,
    });

    expect(outcome).toBe('timeout');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThanOrEqual(11);
    for (const p of seen) {
      expect(p).toMatchObject({ total: 1, completed: 0, pending: 1 });
      expect(p.remainingMs).toBe(600_000 - p.elapsedMs);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].elapsedMs - seen[i - 1].elapsedMs).toBeGreaterThanOrEqual(60_000);
      expect(seen[i].remainingMs).toBeLessThan(seen[i - 1].remainingMs);
    }
  });

  it('does not report progress when there are no check runs', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const progress: unknown[] = [];
    const octokit = { rest: { checks: { listForRef } } };

    await watchChecks({ ...base, octokit: octokit as any, onProgress: (p) => void progress.push(p), sleep, now });

    expect(progress).toEqual([]);
  });
});

describe('watchChecksWithInfraRerun no-checks (#2386)', () => {
  it('passes no-checks through without listing failed runs or rerunning', async () => {
    const { calls: listCalls, fn: listForRef } = recordArgs(async () => ({ data: { check_runs: [] } }));
    const { calls: rerunCalls, fn: rerun } = recordArgs(async () => ({ ok: true }));
    const { calls: watchCalls, fn: watch } = recordArgs(async () => 'no-checks' as const);

    const outcome = await watchChecksWithInfraRerun({
      octokit: { rest: { checks: { listForRef } } } as any,
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/123-ci-poll',
      watch,
      rerun,
      rerunBudget: new Set(),
    });

    expect(outcome).toBe('no-checks');
    expect(watchCalls).toHaveLength(1);
    expect(listCalls).toEqual([]);
    expect(rerunCalls).toEqual([]);
  });
});
