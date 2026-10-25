import { parseDecompositionOutput, renderSlicePlanComment, withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan, StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';
import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

describe('queue PR preflight', () => {
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
  const sliceStory = (n: number) => ({
    title: `Story ${n}`,
    role: 'operator',
    want: `thing ${n} works`,
    soThat: 'value',
    problemStatement: `Problem ${n}`,
    inScope: [`scope ${n}`],
    outOfScope: ['other'],
    acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
    verification: [{ command: 'npm test', passWhen: 'passes' }],
    tracesTo: ['INT-PROBLEM-01'],
  });
  const slicePlan = (): SlicePlan => {
    const stories = [1, 2, 3].map(sliceStory);
    const parsed = parseDecompositionOutput(
      JSON.stringify({
        epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: stories.map((st) => st.title) },
        stories,
      }),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    return {
      issue: 7,
      slices: parsed.decomposition.stories.map((story, i) => ({
        index: i + 1,
        title: story.title,
        story,
        state: 'pending' as const,
      })),
    };
  };
  const prOpenPlan = (): SlicePlan => withSliceState(slicePlan(), 1, 'pr-open', 81);
  const foundPlan = (plan: SlicePlan) => ({ status: 'found' as const, commentId: 5, plan });
  it('creates GitHub-backed preflight operations with PR identity and head-SHA CI checks', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (_query: string, vars: any) => {
        calls.push(['graphql', vars]);
        return {
          repository: {
            pullRequest: {
              id: 'PR_kwDO',
              isDraft: false,
              mergeStateStatus: 'CLEAN',
              reviewDecision: 'APPROVED',
            },
          },
        };
      },
      rest: {
        checks: {
          listForRef: async (opts: any) => {
            calls.push(['checks', opts]);
            return { data: { check_runs: [{ status: 'completed', conclusion: 'failure' }] } };
          },
        },
        pulls: {
          list: async (opts: any) => {
            calls.push(['pulls', opts]);
            return {
              data: [
                {
                  number: 71,
                  body: 'Closes #7',
                  head: {
                    ref: 'ship-it/7-real-branch',
                    sha: 'head-sha-7',
                    repo: { full_name: 'on-par/software-factory' },
                  },
                },
              ],
            };
          },
        },
      },
    };

    const ops = createQueuePreflightOps(octokit, 'on-par', 'software-factory');

    await expect(ops.findOpenPR(7)).resolves.toEqual({
      number: 71,
      branch: 'ship-it/7-real-branch',
      headSha: 'head-sha-7',
      headRepoFullName: 'on-par/software-factory',
    });
    await expect(ops.getLandState(71)).resolves.toEqual({
      id: 'PR_kwDO',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
    });
    await expect(ops.watch('head-sha-7')).resolves.toBe('failure');
    expect(ops.expectedHeadRepoFullName).toBe('on-par/software-factory');
    expect(calls).toEqual([
      ['pulls', { owner: 'on-par', repo: 'software-factory', state: 'open', per_page: 100, page: 1 }],
      ['graphql', { owner: 'on-par', repo: 'software-factory', number: 71 }],
      ['checks', { owner: 'on-par', repo: 'software-factory', ref: 'head-sha-7', per_page: 100, page: 1 }],
    ]);
  });

  it('reads issue bodies and paginates closed prerequisite closing PR evidence', async () => {
    const calls: unknown[] = [];
    let page = 0;
    const octokit: any = {
      rest: {
        issues: {
          get: async (input: any) => {
            calls.push(['issue', input]);
            return { data: { number: input.issue_number, body: null } };
          },
        },
      },
      graphql: async (_query: string, input: any) => {
        calls.push(['graphql', input]);
        page += 1;
        return {
          repository: {
            issue: {
              state: 'CLOSED',
              closedByPullRequestsReferences: {
                nodes: page === 1 ? [{ merged: false }] : [{ merged: true }],
                pageInfo:
                  page === 1 ? { hasNextPage: true, endCursor: 'cursor-1' } : { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      },
    };
    const ops = createQueuePreflightOps(octokit, 'owner', 'repo');
    await expect(ops.readIssueBody(31)).resolves.toBe('');
    await expect(ops.getPrerequisiteState(31)).resolves.toEqual({ state: 'closed', mergedClosingPr: true });
    expect(calls).toEqual([
      ['issue', { owner: 'owner', repo: 'repo', issue_number: 31 }],
      ['graphql', { owner: 'owner', repo: 'repo', number: 31, after: null }],
      ['graphql', { owner: 'owner', repo: 'repo', number: 31, after: 'cursor-1' }],
    ]);
  });

  it('uses the open-state fast path and rejects malformed prerequisite evidence', async () => {
    const graphql = vi.fn(async (_query: string, _input: unknown) => ({ repository: { issue: { state: 'OPEN' } } }));
    const octokit: any = { rest: { issues: { get: async () => ({ data: { number: 2, body: 'text' } }) } }, graphql };
    const ops = createQueuePreflightOps(octokit, 'o', 'r');
    await expect(ops.getPrerequisiteState(2)).resolves.toEqual({ state: 'open', mergedClosingPr: false });
    expect(graphql).toHaveBeenCalledTimes(1);
    octokit.graphql = async () => ({
      repository: {
        issue: {
          state: 'CLOSED',
          closedByPullRequestsReferences: {
            nodes: [{ merged: 'yes' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    await expect(ops.getPrerequisiteState(2)).rejects.toThrow('node was malformed');
  });

  it('builds when no linked open PR exists', async () => {
    await expect(
      preflightQueuedIssue({ number: 7, labels: [] }, { ...baseDeps, findOpenPR: async () => undefined }),
    ).resolves.toEqual({ kind: 'build' });
  });

  it('defers open prerequisites before slice or pull request evidence and reports all unresolved references', async () => {
    const findSlicePlan = vi.fn();
    const findOpenPR = vi.fn();
    const onDeferred = vi.fn();
    const result = await preflightQueuedIssue(
      { number: 3258, labels: [] },
      {
        ...baseDeps,
        readIssueBody: async () => 'Prerequisite: #3256\nPrerequisite: #3257',
        getPrerequisiteState: async () => ({
          state: 'open' as const,
          mergedClosingPr: false,
        }),
        findSlicePlan,
        findOpenPR,
        onDeferred,
      },
    );
    expect(result).toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(3258, 'waiting for prerequisites: #3256, #3257', 'open-prerequisites');
    expect(findSlicePlan).not.toHaveBeenCalled();
    expect(findOpenPR).not.toHaveBeenCalled();
  });
  it('parks a verified closed prerequisite before slice or PR preflight', async () => {
    const onDeferred = vi.fn();
    const result = await preflightQueuedIssue(
      { number: 9, labels: [] },
      {
        ...baseDeps,
        readIssueBody: async () => 'Prerequisite: #4\nPrerequisite: #5',
        getPrerequisiteState: async (number: number) => ({
          state: 'closed' as const,
          mergedClosingPr: number === 4,
        }),
        onDeferred,
      },
    );
    expect(result).toEqual({ kind: 'park', reason: 'prerequisite #5 closed unmerged' });
    expect(onDeferred).not.toHaveBeenCalled();
  });

  it('defers evidence errors ahead of closed-unmerged results and includes known unresolved references', async () => {
    const onDeferred = vi.fn();
    const result = await preflightQueuedIssue(
      { number: 9, labels: [] },
      {
        ...baseDeps,
        readIssueBody: async () => 'Prerequisite: #4\nPrerequisite: #5\nPrerequisite: #6',
        getPrerequisiteState: async (number: number) => {
          if (number === 4) return { state: 'closed' as const, mergedClosingPr: false };
          if (number === 5) return { state: 'open' as const, mergedClosingPr: false };
          throw new Error('rate limited');
        },
        onDeferred,
      },
    );
    expect(result).toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(9, expect.stringContaining('#6: rate limited'));
    expect(onDeferred.mock.calls[0][1]).toContain('#4');
    expect(onDeferred.mock.calls[0][1]).toContain('#5');
  });

  it('defers body lookup failures and leaves dependency phrases outside the declaration syntax alone', async () => {
    const onDeferred = vi.fn();
    await expect(
      preflightQueuedIssue(
        { number: 9, labels: [] },
        {
          ...baseDeps,
          readIssueBody: async () => {
            throw new Error('body denied');
          },
          onDeferred,
        },
      ),
    ).resolves.toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledWith(9, 'issue body lookup failed: body denied');
    const getPrerequisiteState = vi.fn();
    await expect(
      preflightQueuedIssue(
        { number: 9, labels: [] },
        {
          ...baseDeps,
          readIssueBody: async () => 'Related: #4\nblocked by #5',
          getPrerequisiteState,
        },
      ),
    ).resolves.toEqual({ kind: 'build' });
    expect(getPrerequisiteState).not.toHaveBeenCalled();
  });

  it('adopts only a green, non-draft PR and preserves its actual head branch', async () => {
    await expect(
      preflightQueuedIssue(
        { number: 7, labels: [] },
        {
          ...baseDeps,
          findOpenPR: async () => ({
            number: 71,
            branch: 'contributor/real-head',
            headSha: 'abc123',
            headRepoFullName: 'on-par/software-factory',
          }),
          getLandState: async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }),
          watch: async (ref) => {
            expect(ref).toBe('abc123');
            return 'success';
          },
        },
      ),
    ).resolves.toEqual({ kind: 'adopt', branch: 'contributor/real-head' });
  });

  it('fails closed to park for red, timeout, draft, lookup-error, and unresolvable PR evidence', async () => {
    const pr = async () => ({
      number: 71,
      branch: 'contributor/real-head',
      headSha: 'abc123',
      headRepoFullName: 'on-par/software-factory',
    });
    const cases = [
      { watch: async () => 'failure' as const },
      { watch: async () => 'timeout' as const },
      { getLandState: async () => ({ isDraft: true, mergeStateStatus: 'CLEAN' }) },
      { findOpenPR: async () => Promise.reject(new Error('rate limited')) },
      {
        findOpenPR: async () => ({
          number: 71,
          branch: 'fork-head',
          headSha: 'def456',
          headRepoFullName: 'fork/repo',
        }),
      },
    ];

    for (const overrides of cases) {
      const result = await preflightQueuedIssue(
        { number: 7, labels: [] },
        {
          ...baseDeps,
          findOpenPR: pr,
          getLandState: async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }),
          watch: async () => 'success' as const,
          ...overrides,
        },
      );
      expect(result.kind).toBe('park');
    }
  });

  it('defers while the current slice PR is open without any Closes-PR work', async () => {
    const findOpenPR = vi.fn(async () => undefined);
    const getLandState = vi.fn();
    const watch = vi.fn();
    const saveSlicePlan = vi.fn(async () => {});
    const result = await preflightQueuedIssue(
      { number: 7, labels: [] },
      {
        ...baseDeps,
        findOpenPR,
        getLandState,
        watch,
        saveSlicePlan,
        findSlicePlan: async () => foundPlan(prOpenPlan()),
        getPullState: async () => 'open',
      },
    );
    expect(result).toEqual({ kind: 'defer' });
    for (const fn of [findOpenPR, getLandState, watch, saveSlicePlan]) expect(fn).not.toHaveBeenCalled();
  });

  it('marks the slice merged and builds once its PR merged', async () => {
    const saveSlicePlan = vi.fn(async (_issue: number, _plan: SlicePlan) => {});
    const result = await preflightQueuedIssue(
      { number: 7, labels: [] },
      {
        ...baseDeps,
        saveSlicePlan,
        findSlicePlan: async () => foundPlan(prOpenPlan()),
        getPullState: async () => 'merged',
      },
    );
    expect(result).toEqual({ kind: 'build' });
    expect(saveSlicePlan).toHaveBeenCalledTimes(1);
    const [issue, plan] = saveSlicePlan.mock.calls[0];
    expect(issue).toBe(7);
    expect(plan.slices.map((sl) => [sl.state, sl.prNumber])).toEqual([
      ['merged', 81],
      ['pending', undefined],
      ['pending', undefined],
    ]);
  });

  it('parks naming the PR when the slice PR was closed without merging', async () => {
    const saveSlicePlan = vi.fn(async () => {});
    const result = await preflightQueuedIssue(
      { number: 7, labels: [] },
      {
        ...baseDeps,
        saveSlicePlan,
        findSlicePlan: async () => foundPlan(prOpenPlan()),
        getPullState: async () => 'closed',
      },
    );
    expect(result.kind).toBe('park');
    expect(result.kind === 'park' && result.reason).toContain('PR #81');
    expect(result.kind === 'park' && result.reason).toContain('closed without merging');
    expect(saveSlicePlan).not.toHaveBeenCalled();
  });

  it('keeps the Closes-PR decision when there is no slice plan', async () => {
    const getPullState = vi.fn();
    const result = await preflightQueuedIssue(
      { number: 7, labels: [] },
      {
        ...baseDeps,
        getPullState,
        findOpenPR: async () => ({
          number: 71,
          branch: 'contributor/real-head',
          headSha: 'abc123',
          headRepoFullName: 'on-par/software-factory',
        }),
      },
    );
    expect(result).toEqual({ kind: 'adopt', branch: 'contributor/real-head' });
    expect(getPullState).not.toHaveBeenCalled();
  });

  it('falls through for pending and all-merged slice plans', async () => {
    const getPullState = vi.fn();
    const allMerged = [1, 2, 3].reduce((p, n) => withSliceState(p, n, 'merged'), slicePlan());
    for (const plan of [slicePlan(), allMerged]) {
      const result = await preflightQueuedIssue(
        { number: 7, labels: [] },
        { ...baseDeps, getPullState, findSlicePlan: async () => foundPlan(plan) },
      );
      expect(result).toEqual({ kind: 'build' });
    }
    expect(getPullState).not.toHaveBeenCalled();
  });

  it('parks when slice evidence cannot be read or recorded', async () => {
    const noNumber = slicePlan();
    const cases = [
      { findSlicePlan: async () => Promise.reject(new Error('rate limited')) },
      { findSlicePlan: async () => ({ status: 'invalid' as const, commentId: 9, error: 'bad data' }) },
      {
        findSlicePlan: async () =>
          foundPlan({
            ...noNumber,
            slices: noNumber.slices.map((sl, i) => (i === 0 ? { ...sl, state: 'pr-open' as const } : sl)),
          }),
      },
      {
        findSlicePlan: async () => foundPlan(prOpenPlan()),
        getPullState: async () => Promise.reject(new Error('404')),
      },
      {
        findSlicePlan: async () => foundPlan(prOpenPlan()),
        getPullState: async () => 'merged' as const,
        saveSlicePlan: async () => Promise.reject(new Error('403')),
      },
    ];
    for (const overrides of cases) {
      const result = await preflightQueuedIssue({ number: 7, labels: [] }, { ...baseDeps, ...overrides });
      expect(result.kind).toBe('park');
    }
  });

  it('maps slice PR state and reads and rewrites the slice plan comment', async () => {
    const plan = prOpenPlan();
    const updateComment = vi.fn(async () => ({ data: {} }));
    const pulls: Record<number, any> = {
      1: { state: 'closed', merged: true },
      2: { state: 'closed', merged: false, merged_at: null },
      3: { state: 'open', merged: false },
    };
    const octokit: any = {
      rest: {
        pulls: { get: async (o: any) => ({ data: pulls[o.pull_number] }) },
        users: { getAuthenticated: async () => ({ data: { id: 42 } }) },
        issues: {
          listComments: async () => ({
            data: [{ id: 555, user: { id: 42 }, body: renderSlicePlanComment(plan) }],
          }),
          updateComment,
          createComment: vi.fn(),
        },
      },
    };
    const ops = createQueuePreflightOps(octokit, 'on-par', 'software-factory');
    await expect(ops.getPullState(1)).resolves.toBe('merged');
    await expect(ops.getPullState(2)).resolves.toBe('closed');
    await expect(ops.getPullState(3)).resolves.toBe('open');
    await expect(ops.findSlicePlan(7)).resolves.toMatchObject({ status: 'found', commentId: 555, plan });
    await ops.saveSlicePlan(7, withSliceState(plan, 1, 'merged', 81));
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 555 }));
  });

  it('defers an already factory-owned candidate', async () => {
    const findSlicePlan = vi.fn();
    await expect(
      preflightQueuedIssue({ number: 7, labels: ['factory:in-progress'] }, { ...baseDeps, findSlicePlan }),
    ).resolves.toEqual({
      kind: 'defer',
    });
    expect(findSlicePlan).not.toHaveBeenCalled();
  });
});
