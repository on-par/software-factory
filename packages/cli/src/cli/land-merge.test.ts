import { describe, expect, it, vi } from 'vitest';
import { squashMergeAndDelete } from './land-merge.js';

describe('squash merge', () => {
  it('pins the verified head and removes the branch after merging', async () => {
    const merge = vi.fn(async () => ({}));
    const deleteRef = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ data: { base: { ref: 'main' } } }));
    const octokit = { rest: { pulls: { get, merge }, git: { deleteRef } } } as never;
    await squashMergeAndDelete(octokit, 'o', 'r', 'branch', 1, { sha: 'verified' });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ sha: 'verified' }));
    expect(deleteRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/branch' }));
  });

  it('refuses to squash-merge a PR whose base is a factory branch', async () => {
    const merge = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ data: { base: { ref: 'factory/5-prereq' } } }));
    const octokit = { rest: { pulls: { get, merge }, git: { deleteRef: vi.fn() } } } as never;
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'factory/6-x', 9)).rejects.toThrow(
      'refusing to merge PR #9: its base is factory/5-prereq, not main (stacked PR)',
    );
    const run = vi.fn(async () => undefined);
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'factory/6-x', 9, { admin: true, run })).rejects.toThrow(
      'stacked PR',
    );
    expect(merge).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
