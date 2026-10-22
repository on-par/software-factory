import { describe, expect, it, vi } from 'vitest';

import { preflightQueuedIssue } from './index.js';
import { makeQueuePreflightOps } from './queue-preflight.js';

type LandState = { isDraft?: boolean; mergeStateStatus?: string };

const harness = (results: Array<LandState | Error>) => {
  const queue = [...results];
  const getLandState = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra land-state read');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const watch = vi.fn(async (_ref: string) => 'success' as const);
  const onDeferred = vi.fn();
  const deps = {
    expectedHeadRepoFullName: 'on-par/software-factory',
    findSlicePlan: async () => ({ status: 'not-found' as const }),
    findOpenPR: async () => ({
      number: 315,
      branch: 'factory/7-x',
      headSha: 'abc123',
      headRepoFullName: 'on-par/software-factory',
    }),
    getLandState,
    watch,
    saveSlicePlan: async () => {},
    autoMergeStack: false,
    stackMode: false,
    getPullReviews: async () => {
      throw new Error('unexpected review lookup');
    },
    readIssueBody: async () => '',
    getMergedClosingPr: async () => undefined,
    getPrerequisiteState: async () => {
      throw new Error('unexpected prerequisite lookup');
    },
    getPullState: async () => 'open' as const,
    getPullRefs: async () => {
      throw new Error('unexpected refs lookup');
    },
    branchContains: async () => false,
    sleep,
    onDeferred,
  };
  return { deps, getLandState, sleep, watch, onDeferred };
};

const issue = { number: 7, labels: [] };
const clean = { isDraft: false, mergeStateStatus: 'CLEAN' };
const unknown = { isDraft: false, mergeStateStatus: 'UNKNOWN' };

describe('queue preflight merge-state re-read (#3323)', () => {
  it("preflight doesn't park an open PR whose merge state is UNKNOWN then CLEAN (ship-it #294, 2026-10-19)", async () => {
    const h = harness([unknown, clean]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    expect(h.watch).toHaveBeenCalledWith('abc123');
    expect(h.sleep.mock.calls).toEqual([[2000]]);
  });

  it('defers and logs the PR and re-read count when the merge state stays UNKNOWN on all 4 reads', async () => {
    const h = harness([unknown, unknown, unknown, unknown]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
    expect(h.onDeferred).toHaveBeenCalledWith(7, 'PR #315 merge state still UNKNOWN after 3 re-reads');
    expect(h.sleep.mock.calls).toEqual([[2000], [5000], [10000]]);
    expect(h.getLandState).toHaveBeenCalledTimes(4);
    expect(h.watch).not.toHaveBeenCalled();
  });

  it('defers when mergeStateStatus is missing on all reads', async () => {
    const h = harness([{ isDraft: false }, { isDraft: false }, { isDraft: false }, { isDraft: false }]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'defer' });
  });

  it('a re-read that throws counts as UNKNOWN', async () => {
    const recovered = harness([unknown, new Error('boom'), clean]);
    await expect(preflightQueuedIssue(issue, recovered.deps)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
    });
    const failing = harness([unknown, new Error('a'), new Error('b'), new Error('c')]);
    await expect(preflightQueuedIssue(issue, failing.deps)).resolves.toEqual({ kind: 'defer' });
  });

  it('parks when the first land-state read throws', async () => {
    const h = harness([new Error('rate limited')]);
    const out = await preflightQueuedIssue(issue, h.deps);
    expect(out.kind).toBe('park');
    expect(out.kind === 'park' && out.reason).toContain('merge-state lookup failed');
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('behaves as on main when the merge state is DIRTY on the first read', async () => {
    const h = harness([{ isDraft: false, mergeStateStatus: 'DIRTY' }]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    expect(h.getLandState).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('parks a draft revealed by a re-read', async () => {
    const h = harness([unknown, { isDraft: true, mergeStateStatus: 'CLEAN' }]);
    const out = await preflightQueuedIssue(issue, h.deps);
    expect(out.kind).toBe('park');
    expect(out.kind === 'park' && out.reason).toContain('is draft');
  });

  it('makeQueuePreflightOps exposes a sleep and prefers opts.sleep', async () => {
    const watch = async () => 'success' as const;
    const fallback = makeQueuePreflightOps({} as never, 'o', 'r', { watch });
    expect(typeof fallback.sleep).toBe('function');
    await fallback.sleep?.(0);
    const custom = vi.fn(async (_ms: number) => {});
    expect(makeQueuePreflightOps({} as never, 'o', 'r', { watch, sleep: custom }).sleep).toBe(custom);
  });
});
