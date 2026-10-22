import { withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan, StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { preflightQueuedIssue } from './index.js';

const baseDeps = {
  expectedHeadRepoFullName: 'on-par/software-factory',
  findOpenPR: async () => undefined,
  getLandState: async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }),
  watch: async () => 'success' as const,
  findSlicePlan: async () => ({ status: 'not-found' as const }),
  getPullState: async () => 'open' as const,
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  stackMode: false,
  getPullReviews: async (): Promise<StackPullReviews> => Promise.reject(new Error('unexpected review lookup')),
  readIssueBody: async () => '',
  getMergedClosingPr: async (): Promise<number | undefined> => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  getPullRefs: async () => ({ headRef: 'b', baseRef: 'main', headSha: 's' }),
  branchContains: async () => false,
};
const slicePlan = (): SlicePlan => ({
  issue: 7,
  slices: [1, 2, 3].map((index) => ({ index, title: `S${index}`, story: {} as never, state: 'pending' as const })),
});
const foundPlan = (plan: SlicePlan) => ({ status: 'found' as const, commentId: 5, plan });

describe('queue preflight already-landed work (#3375)', () => {
  it('parks a queued issue whose work already landed in a merged PR (T03)', async () => {
    const out = await preflightQueuedIssue(
      { number: 7, labels: [] },
      { ...baseDeps, getMergedClosingPr: async () => 900 },
    );
    expect(out).toEqual({ kind: 'park', reason: 'work already landed: merged PR #900 closes #7' });
  });

  it('builds when no merged PR closes the issue', async () => {
    await expect(preflightQueuedIssue({ number: 7, labels: [] }, baseDeps)).resolves.toEqual({ kind: 'build' });
  });

  it('skips the merged-PR lookup when a slice plan exists', async () => {
    for (const plan of [slicePlan(), withSliceState(withSliceState(slicePlan(), 1, 'merged', 81), 2, 'merged', 82)]) {
      const getMergedClosingPr = vi.fn(async () => 900);
      const out = await preflightQueuedIssue(
        { number: 7, labels: [] },
        { ...baseDeps, findSlicePlan: async () => foundPlan(plan), getMergedClosingPr },
      );
      expect(out).toEqual({ kind: 'build' });
      expect(getMergedClosingPr).not.toHaveBeenCalled();
    }
  });

  it('builds when the merged-PR lookup fails', async () => {
    const getMergedClosingPr = async (): Promise<number | undefined> => {
      throw new Error('rate limited');
    };
    await expect(preflightQueuedIssue({ number: 7, labels: [] }, { ...baseDeps, getMergedClosingPr })).resolves.toEqual(
      {
        kind: 'build',
      },
    );
  });

  it('does not call the merged-PR lookup when an open PR exists', async () => {
    const getMergedClosingPr = vi.fn(async () => 900);
    const out = await preflightQueuedIssue(
      { number: 7, labels: [] },
      {
        ...baseDeps,
        findOpenPR: async () => ({
          number: 50,
          branch: 'factory/7-x',
          headSha: 'abc',
          headRepoFullName: 'on-par/software-factory',
        }),
        getMergedClosingPr,
      },
    );
    expect(out).toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    expect(getMergedClosingPr).not.toHaveBeenCalled();
  });
});
