import type { FactoryEvent } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { findOpenPRsForIssue } from './land.js';
import { runLane } from './index.js';
import { preflightQueuedIssue, type OpenPullRequestEvidence, type QueuePreflightOps } from './queue-preflight.js';

const pr = (over: Partial<OpenPullRequestEvidence> = {}): OpenPullRequestEvidence => ({
  number: 71,
  branch: 'factory/7-fix-it',
  headSha: 'abc123',
  headRepoFullName: 'on-par/software-factory',
  ...over,
});
const ciFailed: FactoryEvent = { ts: 't', type: 'ci-failed', issue: '7', msg: 'CI failed' };

const makeDeps = (over: Partial<QueuePreflightOps> = {}): QueuePreflightOps => ({
  expectedHeadRepoFullName: 'on-par/software-factory',
  branchPrefix: 'factory',
  findOpenPRs: vi.fn(async () => []),
  lastPark: () => undefined,
  getLandState: vi.fn(async () => ({ isDraft: true, mergeStateStatus: 'CLEAN' })) as any,
  watch: vi.fn(async () => 'success' as const),
  findSlicePlan: async () => ({ status: 'not-found' as const }),
  getPullState: async () => 'open' as const,
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  getPullRefs: async () => ({ headRef: 'b', baseRef: 'main', headSha: 's' }),
  ...over,
});
const issue = { number: 7, labels: [] };

describe('preflightQueuedIssue rework adoption (#2253)', () => {
  it('adopts the single draft factory PR after a ci-failed park', async () => {
    const deps = makeDeps({ findOpenPRs: async () => [pr()], lastPark: () => ciFailed });
    await expect(preflightQueuedIssue(issue, deps)).resolves.toEqual({
      kind: 'build',
      reworkPr: { number: 71, branch: 'factory/7-fix-it', headSha: 'abc123' },
    });
    expect(deps.watch).not.toHaveBeenCalled();
  });

  it('parks with an ambiguity reason when two open PRs close the issue', async () => {
    const deps = makeDeps({ findOpenPRs: async () => [pr(), pr({ number: 72 })], lastPark: () => ciFailed });
    const result = await preflightQueuedIssue(issue, deps);
    expect(result.kind).toBe('park');
    expect(result).toMatchObject({ reason: expect.stringContaining('#71, #72') });
    expect(deps.getLandState).not.toHaveBeenCalled();
    expect(deps.watch).not.toHaveBeenCalled();
  });

  it('returns build without reworkPr when no PR is open', async () => {
    await expect(preflightQueuedIssue(issue, makeDeps())).resolves.toEqual({ kind: 'build' });
  });

  it('a draft PR without a ci-failed park still parks as draft', async () => {
    const deps = makeDeps({ findOpenPRs: async () => [pr()], lastPark: () => ({ ...ciFailed, type: 'ci-infra' }) });
    const result = await preflightQueuedIssue(issue, deps);
    expect(result).toEqual({ kind: 'park', reason: 'PR #71 is draft or its draft state is unavailable' });
  });

  it('parks when draft state is unavailable even after a ci-failed park', async () => {
    const deps = makeDeps({
      findOpenPRs: async () => [pr()],
      lastPark: () => ciFailed,
      getLandState: (async () => ({ isDraft: null, mergeStateStatus: 'CLEAN' })) as any,
    });
    expect((await preflightQueuedIssue(issue, deps)).kind).toBe('park');
  });

  it('parks when the PR lookup throws', async () => {
    const deps = makeDeps({ findOpenPRs: async () => Promise.reject(new Error('rate limited')) });
    expect(await preflightQueuedIssue(issue, deps)).toEqual({ kind: 'park', reason: 'PR lookup failed: rate limited' });
  });
});

describe('findOpenPRsForIssue (#2253)', () => {
  it('collects every open PR that closes the issue across pages (#2253)', async () => {
    const mk = (number: number, body: string) => ({
      number,
      body,
      head: {
        ref: `b${number}`,
        sha: `s${number}`,
        repo: number === 3 ? null : { full_name: 'on-par/software-factory' },
      },
    });
    const filler = Array.from({ length: 98 }, (_, i) => mk(100 + i, 'unrelated'));
    const pages = [[mk(1, 'Closes #19'), mk(2, 'closes #190'), ...filler], [mk(3, 'x\nCloses #19')]];
    const octokit: any = { rest: { pulls: { list: async ({ page }: any) => ({ data: pages[page - 1] ?? [] }) } } };

    expect(await findOpenPRsForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual([
      { number: 1, branch: 'b1', headSha: 's1', headRepoFullName: 'on-par/software-factory' },
      { number: 3, branch: 'b3', headSha: 's3', headRepoFullName: null },
    ]);
  });
});

describe('runLane rework claim (#2253)', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
  it('passes the claim reworkPr to ship as ctx.reworkPr (#2253)', async () => {
    const reworkPr = { number: 71, branch: 'factory/7-x', headSha: 'abc' };
    const claims = [
      { issue: 7, decision: { kind: 'build' as const, reworkPr } },
      { issue: 8, decision: { kind: 'build' as const } },
    ];
    const seen: any[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => claims.shift() ?? null,
      ship: async (issue, _opts, ctx) => {
        seen.push([issue, ctx?.reworkPr]);
        return 'b';
      },
      waitMerge: async () => {},
      releaseIssue: async () => {},
      pathExists: () => false,
      emitEvent: () => {},
    });
    expect(seen).toEqual([
      [7, reworkPr],
      [8, undefined],
    ]);
  });
});
