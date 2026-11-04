import type { StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';
import { preflightQueuedIssue } from './index.js';

describe('queue preflight Depends on prerequisites', () => {
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

  it('defers a queued issue whose Depends on prerequisite is still open (#3915)', async () => {
    const findSlicePlan = vi.fn();
    const findOpenPR = vi.fn();
    const onDeferred = vi.fn();
    const result = await preflightQueuedIssue(
      { number: 3893, labels: [] },
      {
        ...baseDeps,
        readIssueBody: async () => 'Depends on: #3892',
        getPrerequisiteState: async () => ({ state: 'open' as const, mergedClosingPr: false }),
        findSlicePlan,
        findOpenPR,
        onDeferred,
      },
    );
    expect(result).toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(3893, 'waiting for prerequisites: #3892', 'open-prerequisites');
    expect(findSlicePlan).not.toHaveBeenCalled();
    expect(findOpenPR).not.toHaveBeenCalled();
  });
});
