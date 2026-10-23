import { describe, expect, it, vi } from 'vitest';
import type { StackPullReviews } from '@on-par/factory-core/internal';
import { preflightQueuedIssue } from './index.js';

describe('queue preflight lane-file hold (#3576)', () => {
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

  it('defers an issue whose lane-file hold is still live (#3576)', async () => {
    const readIssueBody = vi.fn();
    const findOpenPR = vi.fn();
    const onDeferred = vi.fn();
    const laneFileHold = vi.fn(async () => ({ holder: 3232, file: 'src/a.ts' }));
    await expect(
      preflightQueuedIssue(
        { number: 7, labels: ['factory:queued'] },
        { ...baseDeps, readIssueBody, findOpenPR, onDeferred, laneFileHold },
      ),
    ).resolves.toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(7, expect.stringMatching(/#3232.*src\/a\.ts/));
    expect(readIssueBody).not.toHaveBeenCalled();
    expect(findOpenPR).not.toHaveBeenCalled();
  });

  it.each([
    ['no live hold', async () => undefined],
    [
      'a throwing lookup',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('falls through to the normal decision with %s (#3576)', async (_name, laneFileHold) => {
    const readIssueBody = vi.fn(async () => 'no prerequisites');
    await preflightQueuedIssue({ number: 7, labels: ['factory:queued'] }, { ...baseDeps, readIssueBody, laneFileHold });
    expect(readIssueBody).toHaveBeenCalledWith(7);
  });
});
