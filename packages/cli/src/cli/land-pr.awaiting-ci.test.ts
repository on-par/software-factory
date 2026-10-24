import { describe, expect, it, vi } from 'vitest';

import './index.js';
import {
  AwaitingCiError,
  CiFailedError,
  CiUnverifiedError,
  isCiNotGreen,
  isLandLeftOpen,
  landOpenPullRequest,
} from './land-pr.js';

function setup(signal: { runs?: unknown[] | Error; statuses?: number }, repoName = 'software-factory') {
  const log = vi.fn();
  const octokit: any = {
    graphql: async () => ({
      repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'MERGEABLE' } },
    }),
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: 'abc123' }, base: { ref: 'main' } } }), merge: vi.fn() },
      checks: {
        listForRef: async () => {
          if (signal.runs instanceof Error) throw signal.runs;
          return { data: { check_runs: signal.runs ?? [] } };
        },
      },
      repos: {
        getCombinedStatusForRef: async () => ({
          data: { total_count: signal.statuses ?? 0, statuses: [], sha: 'abc123' },
        }),
      },
      git: { deleteRef: async () => {} },
    },
  };
  const watch = vi.fn(async (opts: any) => {
    opts.onNoRequiredChecks?.({ branch: 'main' });
    return 'timeout' as const;
  });
  const land = () =>
    landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName,
      ghRepo: `on-par/${repoName}`,
      repoRoot: '/repo',
      issue: 20,
      branch: 'factory/20-x',
      worktree: '/repo-factory-20',
      prNumber: 7,
      log,
      adminMerge: false,
      watch: watch as any,
    });
  return { log, octokit, land };
}

describe('landOpenPullRequest: CI deadline with nothing registered (#3208)', () => {
  it('throws AwaitingCiError, not a CI failure, when no check run or status exists on the head', async () => {
    const { log, octokit, land } = setup({});
    const err = await land().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwaitingCiError);
    expect(err).not.toBeInstanceOf(CiFailedError);
    expect(err).toMatchObject({ prNumber: 7, headSha: 'abc123' });
    expect(isLandLeftOpen(err)).toBe(true);
    expect(isCiNotGreen(err)).toBe(true);
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'awaiting-ci',
      expect.stringContaining('no CI run or status registered on abc123'),
    );
    expect(log).not.toHaveBeenCalledWith('ci-failed', expect.anything());
  });

  it('still throws CiUnverifiedError when check runs exist, or when only a status exists', async () => {
    await expect(setup({ runs: [{ name: 'verify', status: 'in_progress' }] }).land()).rejects.toBeInstanceOf(
      CiUnverifiedError,
    );
    await expect(setup({ statuses: 1 }).land()).rejects.toBeInstanceOf(CiUnverifiedError);
  });

  it('fails closed to CiUnverifiedError when the signal probe errors', async () => {
    await expect(setup({ runs: new Error('api down') }).land()).rejects.toBeInstanceOf(CiUnverifiedError);
  });

  it('logs the no-branch-protection warning once per repo across two PRs', async () => {
    const first = setup({}, 'warn-once-repo');
    const second = setup({}, 'warn-once-repo');
    await first.land().catch(() => {});
    await second.land().catch(() => {});
    const warning = 'no branch protection on on-par/warn-once-repo@main; using all checks on head';
    expect(first.log).toHaveBeenCalledWith('warn', warning);
    expect(second.log).not.toHaveBeenCalledWith('warn', warning);
  });
});
