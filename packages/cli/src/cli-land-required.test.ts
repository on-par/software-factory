import { watchChecks } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import './cli/index.js';
import { CiFailedError, CiUnverifiedError, landOpenPullRequest } from './cli/land-pr.js';

const baseOpts = {
  owner: 'on-par',
  repoName: 'software-factory',
  ghRepo: 'on-par/software-factory',
  repoRoot: '/repo',
  issue: 20,
  branch: 'ship-it/20-pin',
  worktree: '/repo-factory-20',
  prNumber: 123,
  adminMerge: false,
  pathExists: () => true,
  sleep: async () => {
    throw new Error('sleep should not be called');
  },
};

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function requiredOctokit(runsAt: (ms: number) => any[], clock: { now: () => number }, calls: any[]): any {
  return {
    graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: 'abc123' }, base: { ref: 'main' } } }),
        merge: async (args: any) => calls.push(['merge', args.sha]),
      },
      git: { deleteRef: async () => {} },
      checks: { listForRef: async () => ({ data: { check_runs: runsAt(clock.now()) } }) },
      repos: {
        getStatusChecksProtection: async () => ({ data: { contexts: ['verify'] } }),
        getBranchRules: async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        },
        getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: 'abc123' } }),
      },
    },
  };
}

function land(octokit: any, clock: ReturnType<typeof fakeClock>, logs: Array<[string, string]>) {
  return landOpenPullRequest({
    ...baseOpts,
    octokit,
    log: (type, msg) => logs.push([type, msg]),
    watch: (opts) => watchChecks({ ...opts, sleep: clock.sleep, now: clock.now }),
  });
}

const verify = (conclusion: string) => ({ name: 'verify', status: 'completed', conclusion });

describe('landOpenPullRequest required checks (#3206)', () => {
  it('waits for a required check that registers late and merges the head SHA', async () => {
    const calls: any[] = [];
    const clock = fakeClock();
    const octokit = requiredOctokit((ms) => (ms < 180_000 ? [] : [verify('success')]), clock, calls);

    await land(octokit, clock, []);

    expect(calls).toContainEqual(['merge', 'abc123']);
  });

  it('does not merge while required check verify has not reported and logs it', async () => {
    const calls: any[] = [];
    const clock = fakeClock();
    const logs: Array<[string, string]> = [];
    const lint = { name: 'lint', status: 'completed', conclusion: 'success' };
    const octokit = requiredOctokit(() => [lint], clock, calls);

    await expect(land(octokit, clock, logs)).rejects.toThrow(CiUnverifiedError);

    expect(calls).toEqual([]);
    expect(
      logs.some(
        ([type, msg]) => type === 'land' && msg.includes('waiting for required check verify (not reported yet)'),
      ),
    ).toBe(true);
  });

  it('throws CiFailedError when required check verify fails', async () => {
    const calls: any[] = [];
    const clock = fakeClock();
    const octokit = requiredOctokit(() => [verify('failure')], clock, calls);

    const err = await land(octokit, clock, []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CiFailedError);
    expect((err as CiFailedError).parkReason).toBe('ci-failed');
    expect(calls).toEqual([]);
  });
});
