import type { StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';
import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

describe('queue prerequisite sub-issue evidence (#3703)', () => {
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
  const childOps = (reason: string | undefined, children: unknown, parentPrs: unknown[] = []) => {
    const graphql = vi.fn(async (query: string, _input: unknown) =>
      query.includes('QueuePrerequisiteChildren')
        ? { repository: { issue: { subIssues: children } } }
        : {
            repository: {
              issue: {
                state: 'CLOSED',
                stateReason: reason,
                closedByPullRequestsReferences: { nodes: parentPrs, pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
    );
    const octokit: any = { rest: { issues: { get: async () => ({ data: { number: 5, body: '' } }) } }, graphql };
    return { ops: createQueuePreflightOps(octokit, 'o', 'r'), graphql };
  };
  const child = (state: string, merged: boolean[]) => ({
    number: 1,
    state,
    closedByPullRequestsReferences: { nodes: merged.map((m) => ({ merged: m })) },
  });
  const page = (nodes: unknown[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });

  it('reports mergedViaChildren for a completed parent whose sub-issues all have merged closing PRs', async () => {
    const { ops, graphql } = childOps('COMPLETED', page([child('CLOSED', [false, true]), child('CLOSED', [true])]));
    await expect(ops.getPrerequisiteState(5)).resolves.toEqual({
      state: 'closed',
      mergedClosingPr: false,
      mergedViaChildren: true,
    });
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('keeps closed-unmerged evidence for not_planned, childless, and partially merged children', async () => {
    const cases: Array<[string | undefined, unknown]> = [
      ['NOT_PLANNED', page([child('CLOSED', [true])])],
      ['DUPLICATE', page([child('CLOSED', [true])])],
      [undefined, page([child('CLOSED', [true])])],
      ['COMPLETED', page([])],
      ['COMPLETED', page([child('OPEN', [])])],
      ['COMPLETED', page([child('CLOSED', [true]), child('CLOSED', [false])])],
      ['COMPLETED', page([child('CLOSED', [true])], true)],
    ];
    for (const [reason, children] of cases) {
      const { ops, graphql } = childOps(reason, children);
      const evidence = await ops.getPrerequisiteState(5);
      expect(evidence.mergedViaChildren).not.toBe(true);
      if (reason !== 'COMPLETED') expect(graphql).toHaveBeenCalledTimes(1);
      await expect(
        preflightQueuedIssue(
          { number: 9, labels: [] },
          { ...baseDeps, readIssueBody: async () => 'Prerequisite: #5', getPrerequisiteState: async () => evidence },
        ),
      ).resolves.toEqual({ kind: 'park', reason: 'prerequisite #5 closed unmerged' });
    }
  });

  it('rejects malformed sub-issue evidence', async () => {
    const bad: unknown[] = [
      undefined,
      { nodes: 'x', pageInfo: { hasNextPage: false } },
      { nodes: [], pageInfo: {} },
      page([child('MERGED', [true])]),
      page([{ number: 1, state: 'CLOSED' }]),
      page([{ number: 1, state: 'CLOSED', closedByPullRequestsReferences: { nodes: [{ merged: 'yes' }] } }]),
    ];
    for (const children of bad) {
      const { ops } = childOps('COMPLETED', children);
      await expect(ops.getPrerequisiteState(5)).rejects.toThrow('sub-issue evidence was malformed');
    }
    const { ops } = childOps('COMPLETED', undefined);
    const onDeferred = vi.fn();
    await expect(
      preflightQueuedIssue(
        { number: 9, labels: [] },
        {
          ...baseDeps,
          readIssueBody: async () => 'Prerequisite: #5',
          getPrerequisiteState: (n) => ops.getPrerequisiteState(n),
          onDeferred,
        },
      ),
    ).resolves.toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(9, expect.stringContaining('prerequisite evidence lookup failed'));
  });
});
