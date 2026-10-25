// packages/cli/src/cli/land-pr-claim-signal.test.ts — merge refuses to run once the claim is lost (#3146)

import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { squashMergeAndDelete } from './land-pr.js';

function fakeOctokit() {
  const merge = vi.fn(async () => ({}));
  return {
    octokit: Object.assign({} as Octokit, {
      rest: { pulls: { merge }, git: { deleteRef: vi.fn(async () => ({})) } },
    }),
    merge,
  };
}

describe('squashMergeAndDelete claim signal', () => {
  it('throws the abort reason and calls neither pulls.merge nor gh when aborted', async () => {
    const lost = new Error('claim lost');
    const controller = new AbortController();
    controller.abort(lost);
    const { octokit, merge } = fakeOctokit();
    const run = vi.fn(async () => ({}));
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'b', 5, { signal: controller.signal })).rejects.toBe(lost);
    await expect(
      squashMergeAndDelete(octokit, 'o', 'r', 'b', 5, { admin: true, run, signal: controller.signal }),
    ).rejects.toBe(lost);
    expect(merge).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('merges as before while the signal is healthy', async () => {
    const { octokit, merge } = fakeOctokit();
    await squashMergeAndDelete(octokit, 'o', 'r', 'b', 5, { signal: new AbortController().signal, sha: 'abc' });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 5, sha: 'abc' }));
  });
});
