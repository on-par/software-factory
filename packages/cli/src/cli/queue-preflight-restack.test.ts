import { withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan, StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

const baseDeps = {
  expectedHeadRepoFullName: 'on-par/software-factory',
  findOpenPR: async () => undefined,
  getLandState: async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }),
  watch: async () => 'success' as const,
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  getPullReviews: async (): Promise<StackPullReviews> => {
    throw new Error('unexpected review lookup');
  },
  readIssueBody: async () => '',
  getMergedClosingPr: async () => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  branchContains: async () => false,
};
const slicePlan = (): SlicePlan => ({
  issue: 7,
  slices: [1, 2, 3].map((index) => ({ index, title: `S${index}`, story: {} as never, state: 'pending' as const })),
});
const foundPlan = (plan: SlicePlan) => ({ status: 'found' as const, commentId: 5, plan });

describe('queue preflight restack detection (#3368)', () => {
  const stackPlan = () => withSliceState(withSliceState(slicePlan(), 1, 'pr-open', 81), 2, 'pr-open', 82);
  const refs = async (pr: number) =>
    pr === 81
      ? { headRef: 'factory/7-slice-1', baseRef: 'main', headSha: 'merged-head' }
      : { headRef: 'factory/7-slice-2', baseRef: 'factory/7-slice-1', headSha: 'open-head' };
  const deps = (over: Record<string, unknown> = {}) => ({
    ...baseDeps,
    stackMode: true,
    findSlicePlan: async () => foundPlan(stackPlan()),
    getPullState: async (pr: number) => (pr === 81 ? ('merged' as const) : ('open' as const)),
    getPullRefs: refs,
    ...over,
  });

  it('returns restack when the open slice branch still holds the merged head', async () => {
    const branchContains = vi.fn(async () => true);
    await expect(preflightQueuedIssue({ number: 7, labels: [] }, deps({ branchContains }))).resolves.toEqual({
      kind: 'restack',
      mergedIndex: 1,
      mergedPrNumber: 81,
    });
    expect(branchContains).toHaveBeenCalledWith('merged-head', 'factory/7-slice-2');
  });

  it('detects a merge recorded in the same pass and saves the plan first', async () => {
    const saveSlicePlan = vi.fn(async () => {});
    const out = await preflightQueuedIssue(
      { number: 7, labels: [] },
      deps({ branchContains: async () => true, saveSlicePlan }),
    );
    expect(out.kind).toBe('restack');
    expect(saveSlicePlan).toHaveBeenCalledTimes(1);
  });

  it('falls through to the existing flow when the branch no longer holds the merged head', async () => {
    await expect(
      preflightQueuedIssue({ number: 7, labels: [] }, deps({ branchContains: async () => false })),
    ).resolves.toEqual({ kind: 'defer' });
  });

  it('skips detection in slice mode', async () => {
    const branchContains = vi.fn(async () => true);
    await expect(
      preflightQueuedIssue({ number: 7, labels: [] }, deps({ stackMode: false, branchContains })),
    ).resolves.toEqual({ kind: 'defer' });
    expect(branchContains).not.toHaveBeenCalled();
  });

  it('parks when the check throws', async () => {
    const out = await preflightQueuedIssue(
      { number: 7, labels: [] },
      deps({
        branchContains: async () => {
          throw new Error('compare down');
        },
      }),
    );
    expect(out).toEqual({
      kind: 'park',
      reason: expect.stringContaining('slice 2/3 PR #82 restack check failed: compare down'),
    });
  });
});

describe('queue preflight branchContains (#3368)', () => {
  const opsFor = (compare: (args: { basehead: string }) => Promise<unknown>) =>
    createQueuePreflightOps({ rest: { repos: { compareCommitsWithBasehead: compare } } } as never, 'o', 'r');

  it('is true when the branch is ahead of or identical to the SHA, false when behind or diverged', async () => {
    for (const [status, want] of [
      ['ahead', true],
      ['identical', true],
      ['behind', false],
      ['diverged', false],
    ] as const) {
      const compare = vi.fn(async () => ({ data: { status } }));
      await expect(opsFor(compare).branchContains('abc', 'factory/7-slice-2')).resolves.toBe(want);
      expect(compare).toHaveBeenCalledWith({ owner: 'o', repo: 'r', basehead: 'abc...factory/7-slice-2' });
    }
  });

  it('is false for a missing branch (404) and rethrows any other error', async () => {
    const missing = opsFor(async () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })));
    await expect(missing.branchContains('abc', 'gone')).resolves.toBe(false);
    const down = opsFor(async () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })));
    await expect(down.branchContains('abc', 'b')).rejects.toThrow('boom');
  });

  it('getPullRefs maps a slice PR to its head ref, base ref and head SHA', async () => {
    const get = vi.fn(async () => ({ data: { head: { ref: 'factory/7-slice-2', sha: 'h2' }, base: { ref: 'main' } } }));
    const ops = createQueuePreflightOps({ rest: { pulls: { get } } } as never, 'o', 'r');
    await expect(ops.getPullRefs(82)).resolves.toEqual({
      headRef: 'factory/7-slice-2',
      baseRef: 'main',
      headSha: 'h2',
    });
    expect(get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', pull_number: 82 });
  });
});
