import { describe, expect, it } from 'vitest';
import type { StackPullReviews } from '@on-par/factory-core/internal';
import { preflightQueuedIssue } from './index.js';

const deferrals = () => {
  const deferred: unknown[][] = [];
  return { deferred, onDeferred: (...a: unknown[]) => void deferred.push(a) };
};

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
    const looked: string[] = [];
    const { deferred, onDeferred } = deferrals();
    const readIssueBody = async () => {
      looked.push('readIssueBody');
      return '';
    };
    const findOpenPR = async () => {
      looked.push('findOpenPR');
      return undefined;
    };
    const laneFileHold = async () => ({ holder: 3232, file: 'src/a.ts' });
    await expect(
      preflightQueuedIssue(
        { number: 7, labels: ['factory:queued'] },
        { ...baseDeps, readIssueBody, findOpenPR, onDeferred, laneFileHold },
      ),
    ).resolves.toEqual({ kind: 'defer' });
    expect(deferred).toEqual([[7, expect.stringMatching(/#3232.*src\/a\.ts/)]]);
    expect(looked).toEqual([]);
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
    const read: number[] = [];
    const readIssueBody = async (n: number) => {
      read.push(n);
      return 'no prerequisites';
    };
    await expect(
      preflightQueuedIssue({ number: 7, labels: ['factory:queued'] }, { ...baseDeps, readIssueBody, laneFileHold }),
    ).resolves.toEqual({ kind: 'build' });
    expect(read).toEqual([7]);
  });
});
