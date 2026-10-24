// packages/cli/src/cli/land-pr.awaiting-ci.test.ts — land's CI deadline with nothing registered waits as awaiting-ci (#3208)

import { describe, expect, it } from 'vitest';

import './index.js';
import { AwaitingCiError, CiFailedError, CiUnverifiedError, landOpenPullRequest } from './land-pr.js';

const land = (neverStarted: boolean, events: string[] = []) => {
  const octokit: any = {
    graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
    rest: { pulls: { get: async () => ({ data: { head: { sha: 'f'.repeat(40) }, base: { ref: 'main' } } }) } },
  };
  return landOpenPullRequest({
    octokit,
    owner: 'on-par',
    repoName: 'software-factory',
    ghRepo: 'on-par/software-factory',
    repoRoot: '/repo',
    issue: 20,
    branch: 'ship-it/20-x',
    worktree: '/repo-factory-20',
    prNumber: 123,
    log: (type, msg) => events.push(`${type}: ${msg}`),
    adminMerge: false,
    watch: (async (opts: any) => {
      opts.onDeadline?.({ neverStarted });
      return 'timeout' as const;
    }) as any,
  });
};

describe('landOpenPullRequest: CI deadline (#3208)', () => {
  it('throws AwaitingCiError, not a CiFailedError, when nothing ever registered', async () => {
    const events: string[] = [];
    const err = await land(true, events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwaitingCiError);
    expect(err).not.toBeInstanceOf(CiFailedError);
    expect(err).toMatchObject({ prNumber: 123, headSha: 'f'.repeat(40) });
    expect(events).toEqual([expect.stringMatching(/^awaiting-ci: PR #123: no CI run or status registered on f{12} /)]);
  });

  it('still throws CiUnverifiedError when some check was seen', async () => {
    await expect(land(false)).rejects.toBeInstanceOf(CiUnverifiedError);
  });
});
