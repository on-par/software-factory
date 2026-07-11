import { describe, expect, it } from 'vitest';
import {
  main,
  isPrMerged,
  findOpenPRNumber,
  findOpenPRForIssue,
  squashMergeAndDelete,
  getPullRequestMergeStateStatus,
  landOpenPullRequest,
  LandConflictError,
} from './cli/index.js';

describe('cli', () => {
  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
  });

  it('detects a merge by head branch even when it is outside the recent-closed window', async () => {
    const octokit: any = {
      rest: { pulls: { list: async ({ head }: any) =>
        head === 'on-par:ship-it/22-x'
          ? { data: [{ merged_at: '2026-01-01T00:00:00Z' }] }
          : { data: [] } } },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(true);
  });

  it('returns false when the head branch has no merged PR', async () => {
    const octokit: any = { rest: { pulls: { list: async () => ({ data: [{ merged_at: null }] }) } } };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(false);
  });

  it('finds an open PR number for the matching head branch', async () => {
    const octokit: any = {
      rest: { pulls: { list: async ({ head }: any) =>
        head === 'on-par:ship-it/19-land'
          ? { data: [{ number: 123 }] }
          : { data: [] } } },
    };

    expect(await findOpenPRNumber(octokit, 'on-par', 'software-factory', 'ship-it/19-land')).toBe(123);
  });

  it('returns undefined when no open PR exists for the head branch', async () => {
    const octokit: any = {
      rest: { pulls: { list: async () => ({ data: [] }) } },
    };

    expect(await findOpenPRNumber(octokit, 'on-par', 'software-factory', 'ship-it/19-land')).toBeUndefined();
  });

  it('falls back to matching the open PR that references the issue in its body', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { number: 1, body: 'Closes #7', head: { ref: 'ship-it/1-unrelated' } },
              { number: 42, body: 'Fixes some things.\n\nCloses #19', head: { ref: 'ship-it/19-renamed-title' } },
            ],
          }),
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual({
      number: 42,
      branch: 'ship-it/19-renamed-title',
    });
  });

  it('returns undefined from the issue-body fallback when no open PR references the issue', async () => {
    const octokit: any = {
      rest: { pulls: { list: async () => ({ data: [{ number: 1, body: 'Closes #7', head: { ref: 'x' } }] }) } },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toBeUndefined();
  });

  it('squash-merges a PR and deletes its branch', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };

    // cmdLand reuses withGitLock for merge serialization; lock behavior is covered in core.
    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123);

    expect(calls).toEqual([
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/19-land' }],
    ]);
  });

  it('does not throw when deleting the merged branch fails', async () => {
    const octokit: any = {
      rest: {
        pulls: { merge: async () => {} },
        git: { deleteRef: async () => { throw new Error('not found'); } },
      },
    };

    await expect(
      squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123),
    ).resolves.toBeUndefined();
  });

  it('reads the pull request mergeStateStatus field', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
        return { repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } };
      },
    };

    await expect(
      getPullRequestMergeStateStatus(octokit, 'on-par', 'software-factory', 123),
    ).resolves.toBe('DIRTY');
    expect(calls[0].vars).toEqual({ owner: 'on-par', repo: 'software-factory', number: 123 });
    expect(calls[0].query).toContain('mergeStateStatus');
  });

  it('rebases and force-pushes a DIRTY PR before squash-merging it', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-dirty',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => calls.push(['log', type, msg]),
      run,
      pathExists: () => true,
    });

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', "git push --force-with-lease origin 'ship-it/20-dirty'", { cwd: '/repo-factory-20' }],
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/20-dirty' }],
    ]);
  });

  it('aborts the rebase, logs conflict with the branch, and skips merge when rebase fails', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
      if (command === 'git rebase origin/main') throw new Error('conflict');
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['run', 'git rebase origin/main', { cwd: '/repo-factory-20' }],
      ['run', 'git rebase --abort', { cwd: '/repo-factory-20' }],
      ['log', 'conflict', 'rebase conflict on ship-it/20-dirty — parked'],
    ]);
  });

  it('logs conflict and skips merge when a DIRTY PR worktree is gone', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => false,
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([
      ['run', "gh pr checks '123' --repo 'on-par/software-factory' --watch --fail-fast", { cwd: '/repo', timeout: 600_000 }],
      ['log', 'conflict', 'PR #123 DIRTY on ship-it/20-dirty and worktree gone'],
    ]);
  });
});
