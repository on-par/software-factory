import type { StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
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
    const looked: string[] = [];
    const deferred: unknown[][] = [];
    const onDeferred = (...a: unknown[]) => void deferred.push(a);
    const findSlicePlan = async () => (looked.push('findSlicePlan'), { status: 'not-found' as const });
    const findOpenPR = async () => (looked.push('findOpenPR'), undefined);
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
    expect(deferred).toEqual([[3893, 'waiting for prerequisites: #3892', 'open-prerequisites']]);
    expect(looked).toEqual([]);
  });
});
