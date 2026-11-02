import { describe, expect, it, vi } from 'vitest';
import { squashMergeAndDelete } from './land-merge.js';

describe('squash merge', () => {
  it('pins the verified head and removes the branch after merging', async () => {
    const merge = vi.fn(async () => ({}));
    const deleteRef = vi.fn(async () => ({}));
    const octokit = { rest: { pulls: { merge }, git: { deleteRef } } } as never;
    await squashMergeAndDelete(octokit, 'o', 'r', 'branch', 1, { sha: 'verified' });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ sha: 'verified' }));
    expect(deleteRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/branch' }));
  });
});
