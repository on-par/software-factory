import { withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan, StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

const counting = <R>(result: R) => {
  const state = { count: 0 };
  return { state, fn: async () => (state.count++, result) };
};
const logging =
  <A extends unknown[], R>(log: A[], result: R) =>
  async (...a: A) => (log.push(a), result);

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
    const checked: string[][] = [];
    const branchContains = logging(checked, true);
    await expect(preflightQueuedIssue({ number: 7, labels: [] }, deps({ branchContains }))).resolves.toEqual({
      kind: 'restack',
      mergedIndex: 1,
      mergedPrNumber: 81,
    });
    expect(checked).toEqual([['merged-head', 'factory/7-slice-2']]);
  });

  it('detects a merge recorded in the same pass and saves the plan first', async () => {
    const saved: SlicePlan[] = [];
    const saveSlicePlan = async (_issue: number, plan: SlicePlan) => void saved.push(plan);
    const out = await preflightQueuedIssue(
      { number: 7, labels: [] },
      deps({ branchContains: async () => true, saveSlicePlan }),
    );
    expect(out.kind).toBe('restack');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.slices[0]).toMatchObject({ state: 'merged', prNumber: 81 });
  });

  it('falls through to the existing flow when the branch no longer holds the merged head', async () => {
    await expect(
      preflightQueuedIssue({ number: 7, labels: [] }, deps({ branchContains: async () => false })),
    ).resolves.toEqual({ kind: 'defer' });
  });

  it('skips detection in slice mode', async () => {
    const checks = counting(true);
    await expect(
      preflightQueuedIssue({ number: 7, labels: [] }, deps({ stackMode: false, branchContains: checks.fn })),
    ).resolves.toEqual({ kind: 'defer' });
    expect(checks.state.count).toBe(0);
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
      const compared: unknown[][] = [];
      const compare = logging(compared, { data: { status } });
      await expect(opsFor(compare).branchContains('abc', 'factory/7-slice-2')).resolves.toBe(want);
      expect(compared).toEqual([[{ owner: 'o', repo: 'r', basehead: 'abc...factory/7-slice-2' }]]);
    }
  });

  it('is false for a missing branch (404) and rethrows any other error', async () => {
    const missing = opsFor(async () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })));
    await expect(missing.branchContains('abc', 'gone')).resolves.toBe(false);
    const down = opsFor(async () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })));
    await expect(down.branchContains('abc', 'b')).rejects.toThrow('boom');
  });

  it('getPullRefs maps a slice PR to its head ref, base ref and head SHA', async () => {
    const asked: unknown[][] = [];
    const get = logging(asked, {
      data: { head: { ref: 'factory/7-slice-2', sha: 'h2' }, base: { ref: 'main' }, body: 'text' },
    });
    const ops = createQueuePreflightOps({ rest: { pulls: { get } } } as never, 'o', 'r');
    await expect(ops.getPullRefs(82)).resolves.toEqual({
      headRef: 'factory/7-slice-2',
      baseRef: 'main',
      headSha: 'h2',
      body: 'text',
    });
    expect(asked).toEqual([[{ owner: 'o', repo: 'r', pull_number: 82 }]]);
  });
});
