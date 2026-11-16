import { fakeOctokit } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';
import { squashMergeAndDelete } from './land-merge.js';

describe('squash merge', () => {
  it('pins the verified head and removes the branch after merging', async () => {
    const { octokit, calls } = fakeOctokit({
      'pulls.get': { data: { base: { ref: 'main' } } },
      'pulls.merge': {},
      'git.deleteRef': {},
    });
    await squashMergeAndDelete(octokit, 'o', 'r', 'branch', 1, { sha: 'verified' });
    expect(calls.map(([k]) => k)).toEqual(['pulls.get', 'pulls.merge', 'git.deleteRef']);
    expect(calls[1]?.[1]).toMatchObject({ sha: 'verified' });
    expect(calls[2]?.[1]).toMatchObject({ ref: 'heads/branch' });
  });

  it('refuses to squash-merge a PR whose base is a factory branch', async () => {
    const merge = async () => Promise.reject(new Error('merge must not run'));
    const get = async () => ({ data: { base: { ref: 'factory/5-prereq' } } });
    const octokit = { rest: { pulls: { get, merge }, git: { deleteRef: async () => ({}) } } } as never;
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'factory/6-x', 9)).rejects.toThrow(
      'refusing to merge PR #9: its base is factory/5-prereq, not main (stacked PR)',
    );
    const run = async () => Promise.reject(new Error('run must not run'));
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'factory/6-x', 9, { admin: true, run })).rejects.toThrow(
      'stacked PR',
    );
  });
});
