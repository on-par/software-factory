import type { StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

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
  getMergedClosingPr: async () => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  getPullRefs: async () => ({ headRef: 'b', baseRef: 'main', headSha: 's' }),
  branchContains: async () => false,
};

describe('ci-pending drafts (#3968)', () => {
  const pr = async () => ({
    number: 71,
    branch: 'contributor/real-head',
    headSha: 'abc123',
    headRepoFullName: 'on-par/software-factory',
  });
  const run = (overrides: Record<string, unknown>) =>
    preflightQueuedIssue({ number: 7, labels: [] }, { ...baseDeps, findOpenPR: pr, ...overrides } as any);
  const parked = { kind: 'park', reason: 'PR #71 is draft or its draft state is unavailable' };

  it('adopts a draft PR whose trusted run state is ci-pending without a CI watch', async () => {
    const watch = vi.fn(async () => 'success' as const);
    await expect(
      run({
        getLandState: async () => ({ isDraft: true, mergeStateStatus: 'BLOCKED' }),
        ciPendingDraft: async () => true,
        watch,
      }),
    ).resolves.toEqual({ kind: 'adopt', branch: 'contributor/real-head' });
    expect(watch).not.toHaveBeenCalled();

    await expect(
      run({
        getLandState: async () => ({ isDraft: true, mergeStateStatus: 'UNKNOWN' }),
        ciPendingDraft: async () => true,
        sleep: async () => {},
        watch,
      }),
    ).resolves.toEqual({ kind: 'adopt', branch: 'contributor/real-head' });
    expect(watch).not.toHaveBeenCalled();
  });

  it('parks a draft PR whose run state is not ci-pending or cannot be read', async () => {
    const getLandState = async () => ({ isDraft: true, mergeStateStatus: 'CLEAN' });
    await expect(run({ getLandState, ciPendingDraft: async () => false })).resolves.toEqual(parked);
    await expect(run({ getLandState, ciPendingDraft: async () => Promise.reject(new Error('x')) })).resolves.toEqual(
      parked,
    );
    await expect(run({ getLandState })).resolves.toEqual(parked);
    const ciPendingDraft = vi.fn(async () => true);
    await expect(run({ getLandState: async () => ({ isDraft: undefined }), ciPendingDraft })).resolves.toEqual(parked);
    expect(ciPendingDraft).not.toHaveBeenCalled();
  });

  it('makeQueuePreflightOps().ciPendingDraft is false when no run-state comment is found', async () => {
    const octokit: any = { rest: { issues: { listComments: async () => ({ data: [] }) } }, paginate: async () => [] };
    const ops = createQueuePreflightOps(octokit, 'o', 'r');
    await expect(ops.ciPendingDraft?.(7, 71)).resolves.toBe(false);
  });
});
