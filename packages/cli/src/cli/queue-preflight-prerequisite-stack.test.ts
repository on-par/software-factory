// packages/cli/src/cli/queue-preflight-prerequisite-stack.test.ts — stack on an open prerequisite factory PR (#3916).

import { renderPrerequisiteStackMarker } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { preflightQueuedIssue } from './index.js';
import { makeQueuePreflightOps, type QueuePreflightOps } from './queue-preflight.js';

const REPO = 'on-par/software-factory';
const SHA_B = 'b'.repeat(40);
const SHA_B2 = 'c'.repeat(40);
const prereq = { issue: 5, prNumber: 50, branch: 'factory/5-prereq', headSha: SHA_B };
const issue = { number: 6, labels: [] };

const prereqPr = {
  number: 50,
  branch: 'factory/5-prereq',
  headSha: SHA_B,
  headRepoFullName: REPO,
};
const ownPr = { number: 60, branch: 'factory/6-x', headSha: 'x'.repeat(40), headRepoFullName: REPO };

type PullInfo = { state: 'open' | 'merged' | 'closed'; headSha: string; baseRef: string; body: string };

function harness(
  over: {
    findOpenPR?: QueuePreflightOps['findOpenPR'];
    stackOn?: boolean;
    prerequisiteOpen?: boolean;
    pulls?: Record<number, PullInfo>;
    contains?: boolean;
  } = {},
) {
  const pulls = over.pulls ?? {};
  const getLandState = vi.fn(async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }));
  const onDeferred = vi.fn();
  const deps: QueuePreflightOps = {
    expectedHeadRepoFullName: REPO,
    findSlicePlan: async () => ({ status: 'not-found' as const }),
    findOpenPR:
      over.findOpenPR ??
      (async (n) => {
        if (n === 5) return prereqPr;
        return undefined;
      }),
    getLandState: getLandState as never,
    watch: async () => 'success' as const,
    saveSlicePlan: async () => {},
    autoMergeStack: false,
    stackMode: false,
    stackOnOpenPrerequisite: over.stackOn ?? true,
    getPullReviews: async () => {
      throw new Error('unexpected review lookup');
    },
    readIssueBody: async () => 'Prerequisite: #5',
    getMergedClosingPr: async () => undefined,
    getPrerequisiteState: async () =>
      over.prerequisiteOpen === false
        ? { state: 'closed' as const, mergedClosingPr: true }
        : { state: 'open' as const, mergedClosingPr: false },
    getPullState: async (n) => pulls[n]?.state ?? 'open',
    getPullRefs: async (n) => {
      const p = pulls[n];
      if (!p) throw new Error(`unexpected refs lookup for #${n}`);
      return { headRef: 'h', baseRef: p.baseRef, headSha: p.headSha, body: p.body };
    },
    branchContains: async () => over.contains ?? false,
    onDeferred,
  };
  return { deps, onDeferred, getLandState };
}

const stackedOwn = (over: Partial<PullInfo> = {}): Record<number, PullInfo> => ({
  60: {
    state: 'open',
    headSha: ownPr.headSha,
    baseRef: 'factory/5-prereq',
    body: renderPrerequisiteStackMarker(prereq),
  },
  50: { state: 'open', headSha: SHA_B, baseRef: 'main', body: '', ...over },
});
const withOwn = (n: number) => (n === 5 ? prereqPr : n === 6 ? ownPr : undefined);

describe('queue preflight: stacking on an open prerequisite PR (#3916)', () => {
  it('stacks on an open factory prerequisite PR instead of deferring', async () => {
    const h = harness();
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'build', stackOn: prereq });
    expect(h.onDeferred).not.toHaveBeenCalled();
  });

  it('defers when the open prerequisite has no open factory PR', async () => {
    const h = harness({ findOpenPR: async () => undefined });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
    expect(h.onDeferred).toHaveBeenCalledWith(6, 'waiting for prerequisites: #5', 'open-prerequisites');
  });

  it('defers when the prerequisite PR is a human branch', async () => {
    const h = harness({ findOpenPR: async () => ({ ...prereqPr, branch: 'alice/fix' }) });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
  });

  it('defers when the prerequisite PR comes from a fork', async () => {
    const h = harness({ findOpenPR: async () => ({ ...prereqPr, headRepoFullName: 'fork/software-factory' }) });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
  });

  it('defers when the prerequisite PR lookup fails', async () => {
    const h = harness({
      findOpenPR: async () => {
        throw new Error('api down');
      },
    });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
  });

  it('defers as before when queue.stackOnOpenPrerequisite is false', async () => {
    const h = harness({ stackOn: false });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
    expect(h.onDeferred).toHaveBeenCalledWith(6, 'waiting for prerequisites: #5', 'open-prerequisites');
  });

  it('never adopts a stacked PR for landing while its base is a prerequisite branch', async () => {
    const h = harness({ findOpenPR: async (n) => withOwn(n), pulls: stackedOwn() });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
    expect(h.onDeferred).toHaveBeenCalledWith(6, 'stacked on prerequisite PR #50; waiting for it to merge');
    expect(h.getLandState).not.toHaveBeenCalled();
  });

  it('parks held naming the prerequisite PR when it closed unmerged', async () => {
    const h = harness({ findOpenPR: async (n) => withOwn(n), pulls: stackedOwn({ state: 'closed' }) });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({
      kind: 'held',
      reason: 'prerequisite PR #50 (issue #5) was closed without merging',
      prerequisitePr: 50,
    });
  });

  it('restacks before adopt when the prerequisite head moved', async () => {
    const h = harness({ findOpenPR: async (n) => withOwn(n), pulls: stackedOwn({ headSha: SHA_B2 }) });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({
      kind: 'restack-prerequisite',
      prNumber: 60,
      branch: 'factory/6-x',
      recordedHead: ownPr.headSha,
      stackedOn: prereq,
      onto: { kind: 'prerequisite', newHead: SHA_B2 },
    });
  });

  it('restacks onto main once the prerequisite merged', async () => {
    const h = harness({
      prerequisiteOpen: false,
      findOpenPR: async (n) => (n === 6 ? ownPr : undefined),
      pulls: stackedOwn({ state: 'merged', headSha: SHA_B2 }),
    });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toMatchObject({
      kind: 'restack-prerequisite',
      onto: { kind: 'main', mergedHead: SHA_B2 },
    });
    expect(h.getLandState).not.toHaveBeenCalled();
  });

  it('adopts a PR with a main base as before', async () => {
    const pulls = stackedOwn();
    pulls[60]!.baseRef = 'main';
    const h = harness({ prerequisiteOpen: false, findOpenPR: async (n) => (n === 6 ? ownPr : undefined), pulls });
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'adopt', branch: 'factory/6-x' });
  });

  it('parks when the stacked PR lookup fails on the adopt path', async () => {
    const h = harness({ prerequisiteOpen: false, findOpenPR: async (n) => (n === 6 ? ownPr : undefined) });
    const out = await preflightQueuedIssue(issue, h.deps);
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('wires the switch and the PR body through makeQueuePreflightOps', async () => {
    const get = vi.fn(async () => ({ data: { head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, body: null } }));
    const ops = makeQueuePreflightOps({ rest: { pulls: { get } } } as never, 'o', 'r', {
      watch: async () => 'success',
      stackOnOpenPrerequisite: true,
    });
    expect(ops.stackOnOpenPrerequisite).toBe(true);
    await expect(ops.getPullRefs(1)).resolves.toMatchObject({ body: '' });
    expect(makeQueuePreflightOps({} as never, 'o', 'r', { watch: async () => 'success' }).stackOnOpenPrerequisite).toBe(
      false,
    );
  });
});
