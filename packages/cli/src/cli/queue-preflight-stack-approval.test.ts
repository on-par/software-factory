import { parseDecompositionOutput, withSliceState } from '@on-par/factory-core/internal';
import type { SlicePlan, StackPullReviews } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
import { createQueuePreflightOps, preflightQueuedIssue } from './index.js';

const counting = <R>(result: R, state = { count: 0 }) => ({ state, fn: async () => (state.count++, result) });
const deferrals = (deferred: unknown[][] = []) => ({
  deferred,
  onDeferred: (...a: unknown[]) => void deferred.push(a),
});

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
  getPullReviews: async (): Promise<StackPullReviews> => {
    throw new Error('unexpected review lookup');
  },
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
const foundPlan = (plan: SlicePlan) => ({ status: 'found' as const, commentId: 5, plan });

type PreflightOctokit = Parameters<typeof createQueuePreflightOps>[0];
const reviewOctokit = (
  listReviews: (opts: { page?: number }) => Promise<{ data: unknown[] }>,
  users: Record<string, () => Promise<unknown>>,
  extra: Record<string, unknown> = {},
): PreflightOctokit =>
  Object.assign({} as PreflightOctokit, {
    ...extra,
    rest: { pulls: { get: async () => ({ data: { head: { sha: 'abc' } } }), listReviews }, users },
  });

describe('stack approval gate (#3366)', () => {
  const stackPlan = (): SlicePlan => withSliceState(slicePlan(), 1, 'pr-open', 501);
  const approved = (): StackPullReviews => ({
    headSha: 'h501',
    selfId: 1,
    reviews: [{ reviewerId: 2, state: 'APPROVED', commitId: 'h501' }],
  });
  const stackDeps = (over: Record<string, unknown> = {}) => ({
    ...baseDeps,
    stackMode: true,
    findSlicePlan: async () => foundPlan(stackPlan()),
    getPullState: async () => 'open' as const,
    getPullReviews: async () => approved(),
    ...over,
  });

  const preflight = (over: Record<string, unknown> = {}) =>
    preflightQueuedIssue({ number: 7, labels: [] }, stackDeps(over));

  it('builds the next stack slice once the slice below is approved (#3349)', async () => {
    await expect(preflight()).resolves.toEqual({ kind: 'build' });
  });

  it.each([
    ['awaits approval', async () => ({ headSha: 'h501', selfId: 1, reviews: [] }), ['#501', 'slice 1/3']],
    [
      'changes were requested',
      async () => ({ ...approved(), reviews: [{ reviewerId: 2, state: 'CHANGES_REQUESTED', commitId: 'h501' }] }),
      ['changes requested'],
    ],
    ['the review lookup fails', async () => Promise.reject(new Error('boom')), ['stack approval lookup failed']],
  ])('defers a stack slice and names why when %s (#3366)', async (_name, getPullReviews, parts) => {
    const { deferred, onDeferred } = deferrals();
    await expect(preflight({ onDeferred, getPullReviews })).resolves.toEqual({ kind: 'defer' });
    expect(deferred).toHaveLength(1);
    const [[issue, message]] = deferred as [[number, string]];
    expect(issue).toBe(7);
    for (const part of parts) expect(message).toContain(part);
  });

  it('defers when the slice above is not pending', async () => {
    const plan = withSliceState(stackPlan(), 2, 'not-built');
    const result = await preflight({ findSlicePlan: async () => foundPlan(plan) });
    expect(result).toEqual({ kind: 'defer' });
  });

  it('slice mode keeps deferring an approved open slice until it merges (#3366)', async () => {
    const reviews = counting(approved());
    const result = await preflight({ stackMode: false, getPullReviews: reviews.fn });
    expect(result).toEqual({ kind: 'defer' });
    expect(reviews.state.count).toBe(0);
  });

  it('adopts before reading reviews when stack auto-merge is ready', async () => {
    const reviews = counting(approved());
    const result = await preflight({
      autoMergeStack: true,
      getPullReviews: reviews.fn,
      getPullRefs: async () => ({ headRef: 'b', baseRef: 'main', headSha: 's' }),
    });
    expect(result.kind).toBe('adopt');
    expect(reviews.state.count).toBe(0);
  });

  it('builds when auto-merge is on but the base is not main yet and the slice is approved', async () => {
    const result = await preflight({
      autoMergeStack: true,
      getPullRefs: async () => ({ headRef: 'b', baseRef: 'x', headSha: 's' }),
    });
    expect(result).toEqual({ kind: 'build' });
  });

  it('parks an auto-merge slice when PR refs cannot be read', async () => {
    const watches = counting('success' as const);
    const result = await preflight({
      autoMergeStack: true,
      getPullRefs: async () => {
        throw new Error('refs unavailable');
      },
      watch: watches.fn,
    });
    expect(result).toEqual({ kind: 'park', reason: 'slice 1/3 PR #501 ref lookup failed: refs unavailable' });
    expect(watches.state.count).toBe(0);
  });

  it('parks an auto-merge slice when its CI watch fails', async () => {
    const watched: string[] = [];
    const watch = async (ref: string): Promise<'success'> => (
      watched.push(ref),
      Promise.reject(new Error('CI unavailable'))
    );
    const result = await preflight({ autoMergeStack: true, watch });
    expect(result).toEqual({ kind: 'park', reason: 'CI watch for slice 1/3 PR #501 failed: CI unavailable' });
    expect(watched).toEqual(['s']);
  });

  it('reads PR reviews, paginated, with the factory identity', async () => {
    const listReviews = async (o: any) => ({
      data:
        o.page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              user: { id: 1000 + i },
              state: 'COMMENTED',
              commit_id: 'c',
            }))
          : [{ user: null, state: 'APPROVED', commit_id: null }],
    });
    let identity = 0;
    const getAuthenticated = async () => (identity++, { data: { id: 42 } });
    const octokit = reviewOctokit(listReviews, { getAuthenticated });
    const ops = createQueuePreflightOps(octokit, 'o', 'r', { stackMode: true });
    expect(ops.stackMode).toBe(true);
    const first = await ops.getPullReviews(5);
    await ops.getPullReviews(5);
    expect(first.headSha).toBe('abc');
    expect(first.selfId).toBe(42);
    expect(first.reviews).toHaveLength(101);
    expect(first.reviews[0]).toEqual({ reviewerId: 1000, state: 'COMMENTED', commitId: 'c' });
    expect(first.reviews[100]).toEqual({ reviewerId: null, state: 'APPROVED', commitId: null });
    expect(identity).toBe(1);
    expect(createQueuePreflightOps(octokit, 'o', 'r').stackMode).toBe(false);
  });

  it('drops only the App bot reviews under a GitHub App installation token', async () => {
    const reviewsBot = { id: 9001, login: 'factory-app[bot]', type: 'Bot' };
    const listReviews = async () => ({
      data: [
        { user: { id: 9001, login: 'factory-app[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: 'abc' },
        { user: { id: 9002, login: 'other-app[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: 'abc' },
        { user: { id: 5, login: 'someone', type: 'User' }, state: 'APPROVED', commit_id: 'abc' },
      ],
    });
    const getAuthenticated = async () => {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    };
    let viewerReads = 0;
    const graphql = async () => (viewerReads++, { viewer: { login: 'factory-app[bot]', databaseId: 9001 } });
    const octokit = reviewOctokit(
      listReviews,
      { getAuthenticated, getByUsername: async () => ({ data: reviewsBot }) },
      { graphql },
    );
    const ops = createQueuePreflightOps(octokit, 'o', 'r', { stackMode: true });
    const pull = await ops.getPullReviews(5);
    expect(pull.selfId).toBe(9001);
    expect(pull.reviews).toEqual([
      { reviewerId: 9002, state: 'COMMENTED', commitId: 'abc' },
      { reviewerId: 5, state: 'APPROVED', commitId: 'abc' },
    ]);
    expect(viewerReads).toBe(1);
  });

  it('retries the identity lookup after a failure instead of caching the rejection', async () => {
    const listReviews = async () => ({ data: [] });
    let identity = 0;
    const getAuthenticated = async () => {
      identity++;
      if (identity === 1) throw Object.assign(new Error('Server Error'), { status: 500 });
      return { data: { id: 42, login: 'octo', type: 'User' } };
    };
    const octokit = reviewOctokit(listReviews, { getAuthenticated });
    const ops = createQueuePreflightOps(octokit, 'o', 'r', { stackMode: true });
    await expect(ops.getPullReviews(5)).rejects.toThrow('Server Error');
    const second = await ops.getPullReviews(5);
    expect(second.selfId).toBe(42);
    expect(identity).toBe(2);
  });
});
