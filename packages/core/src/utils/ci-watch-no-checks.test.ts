import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CI_NO_CHECKS_GRACE_MS,
  resolveCiNoChecksGraceMs,
  watchChecks,
  watchChecksWithInfraRerun,
} from './ci-watch.js';

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

const pending = [{ status: 'in_progress', conclusion: null }];

describe('watchChecks no-checks early exit and progress (#2386)', () => {
  const base = { owner: 'on-par', repo: 'software-factory', ref: 'ship-it/123-ci-poll' };

  it('returns no-checks after the grace period when there are no check runs and no commit statuses', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => {
      expect(now()).toBeGreaterThanOrEqual(90_000);
      return { data: { total_count: 0, statuses: [], sha: 'abc123' } };
    });
    const onNoChecks = vi.fn();
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({
      ...base,
      octokit: octokit as any,
      noChecksGraceMs: 90_000,
      onNoChecks,
      sleep,
      now,
    });

    expect(outcome).toBe('no-checks');
    expect(onNoChecks).toHaveBeenCalledTimes(1);
    expect(onNoChecks.mock.calls[0][0]).toMatchObject({ sha: 'abc123', reason: 'grace-elapsed' });
    expect(now()).toBeGreaterThanOrEqual(90_000);
    expect(now()).toBeLessThanOrEqual(90_000 + 60_000);
    expect(getCombinedStatusForRef).toHaveBeenCalledTimes(1);
  });

  it('keeps watching when commit statuses exist even with zero check runs', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => ({ data: { total_count: 1, statuses: [{}], sha: 'abc123' } }));
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(getCombinedStatusForRef).toHaveBeenCalled();
  });

  it('keeps watching when the combined-status call throws', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => {
      throw new Error('boom');
    });
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, noChecksGraceMs: 90_000, sleep, now });

    expect(outcome).toBe('timeout');
    expect(now()).toBeGreaterThanOrEqual(600_000);
    expect(getCombinedStatusForRef.mock.calls.length).toBeGreaterThan(3);
  });

  it('never checks statuses or returns no-checks when noChecksGraceMs is unset', async () => {
    const { listForRef } = scriptChecks([[]]);
    const { now, sleep } = createClock();
    const getCombinedStatusForRef = vi.fn(async () => ({ data: { total_count: 0, statuses: [], sha: 'abc123' } }));
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({ ...base, octokit: octokit as any, sleep, now });

    expect(outcome).toBe('timeout');
    expect(getCombinedStatusForRef).not.toHaveBeenCalled();
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
    const onProgress = vi.fn();
    const octokit = { rest: { checks: { listForRef } } };

    await watchChecks({ ...base, octokit: octokit as any, onProgress, sleep, now });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('resolveCiNoChecksGraceMs', () => {
  it('defaults to 90s, honors a valid override, and falls back on invalid values', () => {
    expect(resolveCiNoChecksGraceMs({})).toBe(DEFAULT_CI_NO_CHECKS_GRACE_MS);
    expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: '30' })).toBe(30_000);
    expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: '0' })).toBe(0);
    for (const bad of ['abc', '-5', '']) {
      expect(resolveCiNoChecksGraceMs({ FACTORY_CI_NO_CHECKS_GRACE_SECONDS: bad })).toBe(90_000);
    }
  });
});

describe('watchChecksWithInfraRerun no-checks (#2386)', () => {
  it('passes no-checks through without listing failed runs or rerunning', async () => {
    const listForRef = vi.fn(async () => ({ data: { check_runs: [] } }));
    const rerun = vi.fn(async () => ({ ok: true }));
    const watch = vi.fn(async () => 'no-checks' as const);

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
    expect(watch).toHaveBeenCalledTimes(1);
    expect(listForRef).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });
});
