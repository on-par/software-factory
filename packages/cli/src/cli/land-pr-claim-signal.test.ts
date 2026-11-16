// packages/cli/src/cli/land-pr-claim-signal.test.ts — merge refuses to run once the claim is lost (#3146)

import { fakeOctokit } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';

import { squashMergeAndDelete } from './land-pr.js';

describe('squashMergeAndDelete claim signal', () => {
  it('throws the abort reason and calls neither pulls.merge nor gh when aborted', async () => {
    const lost = new Error('claim lost');
    const controller = new AbortController();
    controller.abort(lost);
    const { octokit, calls } = fakeOctokit({ 'pulls.get': { data: { base: { ref: 'main' } } } });
    const run = async () => Promise.reject(new Error('run must not run'));
    await expect(squashMergeAndDelete(octokit, 'o', 'r', 'b', 5, { signal: controller.signal })).rejects.toBe(lost);
    await expect(
      squashMergeAndDelete(octokit, 'o', 'r', 'b', 5, { admin: true, run, signal: controller.signal }),
    ).rejects.toBe(lost);
    expect(calls).toEqual([]);
  });
});
