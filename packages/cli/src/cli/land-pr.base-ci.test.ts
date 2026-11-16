import { describe, expect, it } from 'vitest';
import './index.js';
import { isLandLeftOpen, landOpenPullRequest } from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';

function land(
  adminMerge: boolean,
  baseGate: { check: (wait?: boolean) => Promise<void>; record: () => Promise<void> },
) {
  const merges: unknown[] = [];
  const logs: Array<[string, string]> = [];
  const octokit = {
    graphql: async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: 'pr' }, base: { ref: 'main' } } }),
        merge: async (args: unknown) => {
          merges.push(args);
          return { data: { merged: true } };
        },
      },
      git: { deleteRef: async () => ({}) },
    },
  } as never;
  const result = landOpenPullRequest({
    octokit,
    owner: 'o',
    repoName: 'r',
    ghRepo: 'o/r',
    repoRoot: '/r',
    issue: 1,
    branch: 'b',
    worktree: '/w',
    prNumber: 2,
    log: (kind: string, msg: string) => void logs.push([kind, msg]),
    skipCI: true,
    adminMerge,
    sleep: async () => {},
    run: async () => Promise.reject(new Error('run must not run')),
    behindProbe: async () => false,
    baseGate,
  }).catch((e: unknown) => e);
  return { result, merges, logs };
}

describe('landing with base CI', () => {
  it.each([false, true])('leaves a PR open when the base fails under the lock (admin=%s)', async (adminMerge) => {
    const waits: Array<boolean | undefined> = [];
    const { result, merges } = land(adminMerge, {
      check: async (wait) => {
        waits.push(wait);
        if (wait === false) throw new BaseCiPendingError('base failed');
      },
      record: async () => {},
    });
    expect(isLandLeftOpen(await result)).toBe(true);
    expect(waits).toEqual([undefined, false]);
    expect(merges).toEqual([]);
  });
  it('keeps a completed merge when recording its merge commit fails', async () => {
    const { result, merges, logs } = land(false, {
      check: async () => {},
      record: async () => Promise.reject(new Error('gone')),
    });
    expect(await result).not.toBeInstanceOf(Error);
    expect(merges).toHaveLength(1);
    expect(logs).toContainEqual(['warn', expect.stringContaining('could not record merge commit')]);
  });
});
