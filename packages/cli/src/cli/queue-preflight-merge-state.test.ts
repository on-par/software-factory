import { describe, expect, it } from 'vitest';

import { preflightQueuedIssue } from './index.js';
import { makeQueuePreflightOps } from './queue-preflight.js';

type LandState = { isDraft?: boolean; mergeStateStatus?: string };

const harness = (results: Array<LandState | Error>) => {
  const queue = [...results];
  const rec = { landReads: 0, slept: [] as number[], watched: [] as string[], deferred: [] as unknown[][] };
  const getLandState = async () => {
    rec.landReads++;
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra land-state read');
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms: number) => void rec.slept.push(ms);
  const watch = async (ref: string) => {
    rec.watched.push(ref);
    return 'success' as const;
  };
  const onDeferred = (...args: unknown[]) => void rec.deferred.push(args);
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
    getPullRefs: async () => ({ headRef: 'factory/7-x', baseRef: 'main', headSha: 'abc123', body: '' }),
    branchContains: async () => false,
    sleep,
    onDeferred,
  };
  return { deps, rec };
};

const issue = { number: 7, labels: [] };

const expectSyncMainAdopt = async (h: ReturnType<typeof harness>) => {
  await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({
    kind: 'adopt',
    branch: 'factory/7-x',
    syncMain: true,
  });
  expect(h.rec.watched).toEqual([]);
};
const clean = { isDraft: false, mergeStateStatus: 'CLEAN' };
const unknown = { isDraft: false, mergeStateStatus: 'UNKNOWN' };

describe('queue preflight merge-state re-read (#3323)', () => {
  it("preflight doesn't park an open PR whose merge state is UNKNOWN then CLEAN (ship-it #294, 2026-10-19)", async () => {
    const h = harness([unknown, clean]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    expect(h.rec.watched).toEqual(['abc123']);
    expect(h.rec.slept).toEqual([2000]);
  });

  it('adopts with syncMain when the merge state stays UNKNOWN on all 4 reads', async () => {
    const h = harness([unknown, unknown, unknown, unknown]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
      syncMain: true,
    });
    expect(h.rec.deferred).toEqual([]);
    expect(h.rec.slept).toEqual([2000, 5000, 10000]);
    expect(h.rec.landReads).toBe(4);
    expect(h.rec.watched).toEqual([]);
  });

  it('adopts with syncMain when mergeStateStatus is missing on all reads', async () => {
    const h = harness([{ isDraft: false }, { isDraft: false }, { isDraft: false }, { isDraft: false }]);
    await expect(preflightQueuedIssue(issue, h.deps)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
      syncMain: true,
    });
  });

  it('a re-read that throws counts as UNKNOWN', async () => {
    const recovered = harness([unknown, new Error('boom'), clean]);
    await expect(preflightQueuedIssue(issue, recovered.deps)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
    });
    const failing = harness([unknown, new Error('a'), new Error('b'), new Error('c')]);
    await expect(preflightQueuedIssue(issue, failing.deps)).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
      syncMain: true,
    });
  });

  it('parks when the first land-state read throws', async () => {
    const h = harness([new Error('rate limited')]);
    const out = await preflightQueuedIssue(issue, h.deps);
    expect(out.kind).toBe('park');
    expect(out.kind === 'park' && out.reason).toContain('merge-state lookup failed');
    expect(h.rec.slept).toEqual([]);
  });

  it('adopts DIRTY with syncMain and skips the CI watch', async () => {
    const h = harness([{ isDraft: false, mergeStateStatus: 'DIRTY' }]);
    await expectSyncMainAdopt(h);
    expect(h.rec.landReads).toBe(1);
    expect(h.rec.slept).toEqual([]);
  });

  it('adopts with syncMain, without a watch, when a re-read reveals DIRTY after UNKNOWN', async () => {
    const h = harness([unknown, { isDraft: false, mergeStateStatus: 'DIRTY' }]);
    await expectSyncMainAdopt(h);
  });

  it('parks a draft revealed by a re-read while the state is still UNKNOWN', async () => {
    const h = harness([unknown, unknown, unknown, { isDraft: true, mergeStateStatus: 'UNKNOWN' }]);
    const out = await preflightQueuedIssue(issue, h.deps);
    expect(out.kind).toBe('park');
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
    const custom = async (_ms: number) => {};
    expect(makeQueuePreflightOps({} as never, 'o', 'r', { watch, sleep: custom }).sleep).toBe(custom);
  });
});
