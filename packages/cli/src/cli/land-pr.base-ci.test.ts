import { describe, expect, it, vi } from 'vitest';
import './index.js';
import { isLandLeftOpen, landOpenPullRequest } from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';

describe('landing with base CI', () => {
  it.each([false, true])('leaves a PR open when the base fails under the lock (admin=%s)', async (adminMerge) => {
    const merge = vi.fn();
    const run = vi.fn();
    const octokit = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: { get: async () => ({ data: { head: { sha: 'pr' }, base: { ref: 'main' } } }), merge },
        git: { deleteRef: vi.fn() },
      },
    } as never;
    const check = vi.fn(async (wait?: boolean) => {
      if (wait === false) throw new BaseCiPendingError('base failed');
    });
    const err = await landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log: vi.fn(),
      skipCI: true,
      adminMerge,
      run,
      behindProbe: async () => false,
      baseGate: { check, record: vi.fn() },
    }).catch((e: unknown) => e);
    expect(isLandLeftOpen(err)).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
    expect(merge).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps a completed merge when recording its merge commit fails', async () => {
    const merge = vi.fn(async () => ({ data: { merged: true } }));
    const log = vi.fn();
    const octokit = {
      graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: { get: async () => ({ data: { head: { sha: 'pr' }, base: { ref: 'main' } } }), merge },
        git: { deleteRef: async () => ({}) },
      },
    } as never;
    const record = vi.fn(async () => {
      throw new Error('gone');
    });
    await landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log,
      skipCI: true,
      adminMerge: false,
      sleep: async () => {},
      run: vi.fn(),
      behindProbe: async () => false,
      baseGate: { check: vi.fn(async () => {}), record },
    });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not record merge commit'));
  });
});
