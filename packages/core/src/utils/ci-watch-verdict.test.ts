import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CI_NO_CHECKS_GRACE_MS, noChecksVerdictMs, watchChecks } from './ci-watch.js';

describe('noChecksVerdictMs', () => {
  it('returns the first poll time at or after the grace', () => {
    expect(noChecksVerdictMs()).toBe(105_000);
    expect(noChecksVerdictMs(0)).toBe(0);
    expect(noChecksVerdictMs(15_000)).toBe(15_000);
    expect(noChecksVerdictMs(200_000)).toBe(225_000);
    expect(noChecksVerdictMs(90_000, 0)).toBe(90_000);
  });

  it('matches the waitedMs watchChecks reports for a grace-elapsed no-checks verdict', async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const listForRef = async () => ({ data: { check_runs: [] } });
    const getCombinedStatusForRef = vi.fn(async () => ({ data: { total_count: 0, statuses: [], sha: 'abc123' } }));
    const onNoChecks = vi.fn();
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/3098-readme-wait',
      octokit: octokit as any,
      noChecksGraceMs: DEFAULT_CI_NO_CHECKS_GRACE_MS,
      onNoChecks,
      sleep,
      now,
    });

    expect(outcome).toBe('no-checks');
    const info = onNoChecks.mock.calls[0][0];
    expect(info.reason).toBe('grace-elapsed');
    expect(info.waitedMs).toBe(noChecksVerdictMs());
  });
});
