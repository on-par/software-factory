import { describe, expect, it } from 'vitest';

import { watchChecks } from './ci-watch.js';

describe('watchChecks no-checks verdict', () => {
  it('reports waitedMs as the first poll time at or after the grace', async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const listForRef = async () => ({ data: { check_runs: [] } });
    const getCombinedStatusForRef = async () => ({ data: { total_count: 0, statuses: [], sha: 'abc123' } });
    const infos: unknown[] = [];
    const octokit = { rest: { checks: { listForRef }, repos: { getCombinedStatusForRef } } };

    const outcome = await watchChecks({
      owner: 'on-par',
      repo: 'software-factory',
      ref: 'ship-it/3098-readme-wait',
      octokit: octokit as any,
      noChecksGraceMs: 90_000,
      onNoChecks: (i) => void infos.push(i),
      sleep,
      now,
    });

    expect(outcome).toBe('no-checks');
    expect(infos).toEqual([expect.objectContaining({ reason: 'grace-elapsed', waitedMs: 105_000 })]);
  });
});
