// packages/cli/src/cli/ci-pending-draft-sweep.test.ts — land or CI-rework factory drafts SHIP left for pending CI (#3932)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, workKeyFromIssue, type EventKind } from '@on-par/factory-core';
import { loadPrRunState, savePrRunState, type CiOutcome, type PrRunState } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runCiPendingDraftSweep,
  sweepCiPendingDrafts,
  type CiPendingDraftSweepDeps,
} from './ci-pending-draft-sweep.js';
import { MergeGatedError } from './land-pr.js';
import type { waitForMerge } from './land.js';

const SELF = 7;
const REPO = 'o/r';
const SHA = 'a'.repeat(40);

interface PullSpec {
  number: number;
  issue: number;
  draft?: boolean;
  ref?: string;
}

function statePayload(issue: number, pr: number, over: Partial<PrRunState> = {}): PrRunState {
  return {
    version: 1,
    key: workKeyFromIssue(issue),
    prNumber: pr,
    status: 'awaiting-ci',
    draftReason: 'ci-pending',
    spec: { sha256: '', summary: 'goal' },
    checkRework: { used: 0, cap: 3 },
    reviewRework: { used: 0, cap: 3 },
    handledReviewIds: [],
    handledCommentIds: [],
    rounds: [],
    updatedAt: '2026-11-04T01:00:00.000Z',
    ...over,
  };
}

type Stored = { id: number; user: { id: number }; body: string };

function fakeOctokit(pulls: PullSpec[], comments: Record<number, Stored[]>) {
  const listed: unknown[] = [];
  const rest = {
    users: { getAuthenticated: async () => ({ data: { id: SELF } }) },
    pulls: {
      list: async (p: unknown) => {
        listed.push(p);
        return {
          data: pulls.map((p2) => ({
            number: p2.number,
            draft: p2.draft ?? true,
            node_id: `PR_${p2.number}`,
            head: { ref: p2.ref ?? `factory/${p2.issue}-thing`, sha: SHA },
            base: { ref: 'main' },
          })),
        };
      },
    },
    issues: {
      listComments: async ({ issue_number, page }: { issue_number: number; page: number }) => ({
        data: page === 1 ? (comments[issue_number] ?? []) : [],
      }),
      createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
        const c = { id: 900 + (comments[issue_number]?.length ?? 0), user: { id: SELF }, body };
        (comments[issue_number] ??= []).push(c);
        return { data: c };
      },
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
        for (const list of Object.values(comments)) {
          const c = list.find((x) => x.id === comment_id);
          if (c) c.body = body;
        }
        return { data: {} };
      },
    },
  };
  return { octokit: Object.assign({} as Octokit, { rest }), listed };
}

/** A run-state comment written the way production writes it (savePrRunState), optionally re-authored. */
async function stateComment(state: PrRunState, userId = SELF): Promise<Stored> {
  const scratch: Record<number, Stored[]> = {};
  const { octokit } = fakeOctokit([], scratch);
  await savePrRunState({ octokit, repo: REPO, prNumber: state.prNumber, state });
  const stored = scratch[state.prNumber]?.[0];
  if (!stored) throw new Error('state comment was not written');
  return { ...stored, id: 10, user: { id: userId } };
}

function setup(
  pulls: PullSpec[],
  comments: Record<number, Stored[]>,
  over: Partial<CiPendingDraftSweepDeps> = {},
  verdict: CiOutcome = 'success',
) {
  const { octokit } = fakeOctokit(pulls, comments);
  const logs: { type: EventKind; issue: number; msg: string }[] = [];
  const deps: CiPendingDraftSweepDeps = {
    octokit,
    ghRepo: REPO,
    branchPrefix: 'factory',
    mergeEnabled: () => true,
    probeCi: vi.fn(async () => verdict),
    markReady: vi.fn(async () => {}),
    land: vi.fn(async () => {}),
    queueRework: vi.fn(async () => ({ outcome: 'queued' as const })),
    log: (type, issue, msg) => logs.push({ type, issue, msg }),
    ...over,
  };
  return { deps, logs, comments };
}

const draftOf = async (
  comments: Record<number, Stored[]>,
  pr: number,
  issue: number,
): Promise<PrRunState | undefined> => {
  const { octokit } = fakeOctokit([], comments);
  const loaded = await loadPrRunState({ octokit, repo: REPO, prNumber: pr, key: workKeyFromIssue(issue) });
  return loaded.status === 'found' ? loaded.state : undefined;
};

describe('sweepCiPendingDrafts (#3932)', () => {
  it('marks a green CI-pending draft ready and lands it through waitForMerge', async () => {
    const comments = { 5: [await stateComment(statePayload(42, 5))] };
    const { deps, logs } = setup([{ number: 5, issue: 42 }], comments);
    const results = await sweepCiPendingDrafts(deps);
    expect(results).toEqual([{ pr: 5, issue: 42, action: 'landed' }]);
    expect(deps.probeCi).toHaveBeenCalledWith({ headSha: SHA, baseRef: 'main' });
    expect(deps.markReady).toHaveBeenCalledWith('PR_5');
    expect(deps.land).toHaveBeenCalledWith(42, 'factory/42-thing');
    expect(logs.map((l) => l.type)).toContain('ready');
    const saved = await draftOf(comments, 5, 42);
    expect(saved).toMatchObject({ status: 'awaiting-review' });
    expect(saved).not.toHaveProperty('draftReason');
  });

  it('treats no-checks like green', async () => {
    const { deps } = setup(
      [{ number: 5, issue: 42 }],
      { 5: [await stateComment(statePayload(42, 5))] },
      {},
      'no-checks',
    );
    expect((await sweepCiPendingDrafts(deps))[0]?.action).toBe('landed');
  });

  it('logs merge-gated and only marks ready when auto-merge is off', async () => {
    const { deps, logs } = setup(
      [{ number: 5, issue: 42 }],
      { 5: [await stateComment(statePayload(42, 5))] },
      {
        mergeEnabled: () => false,
      },
    );
    expect(await sweepCiPendingDrafts(deps)).toEqual([{ pr: 5, issue: 42, action: 'merge-gated' }]);
    expect(deps.markReady).toHaveBeenCalled();
    expect(deps.land).not.toHaveBeenCalled();
    expect(logs.some((l) => l.type === 'merge-gated' && l.msg.includes('auto-merge off'))).toBe(true);
  });

  it('reports a MergeGatedError from land as merge-gated and any other land error as land-failed', async () => {
    const gated = setup(
      [{ number: 5, issue: 42 }],
      { 5: [await stateComment(statePayload(42, 5))] },
      {
        land: async () => {
          throw new MergeGatedError('gated', 42, 5, 'factory:no-auto-merge');
        },
      },
    );
    expect((await sweepCiPendingDrafts(gated.deps))[0]?.action).toBe('merge-gated');
    const failed = setup(
      [{ number: 5, issue: 42 }],
      { 5: [await stateComment(statePayload(42, 5))] },
      {
        land: async () => {
          throw new Error('conflict');
        },
      },
    );
    expect((await sweepCiPendingDrafts(failed.deps))[0]).toMatchObject({ action: 'land-failed', detail: 'conflict' });
    expect(failed.logs.some((l) => l.type === 'warn')).toBe(true);
  });

  it('queues CI rework for a red CI-pending draft', async () => {
    const comments = { 5: [await stateComment(statePayload(42, 5))] };
    const { deps, logs } = setup([{ number: 5, issue: 42 }], comments, {}, 'failure');
    expect(await sweepCiPendingDrafts(deps)).toEqual([{ pr: 5, issue: 42, action: 'ci-rework' }]);
    expect(deps.queueRework).toHaveBeenCalledWith(42, 5);
    expect(deps.markReady).not.toHaveBeenCalled();
    expect(logs.some((l) => l.type === 'rework')).toBe(true);
    expect(await draftOf(comments, 5, 42)).not.toHaveProperty('draftReason');
  });

  it('keeps the reason when the rework could not be queued', async () => {
    const comments = { 5: [await stateComment(statePayload(42, 5))] };
    const { deps, logs } = setup(
      [{ number: 5, issue: 42 }],
      comments,
      {
        queueRework: async () => ({ outcome: 'skipped', detail: 'in-progress' }),
      },
      'failure',
    );
    expect((await sweepCiPendingDrafts(deps))[0]).toMatchObject({ action: 'skipped', detail: 'in-progress' });
    expect(logs.some((l) => l.type === 'warn')).toBe(true);
    expect(await draftOf(comments, 5, 42)).toMatchObject({ draftReason: 'ci-pending' });
  });

  it('leaves a still-pending CI-pending draft and keeps its reason', async () => {
    const comments = { 5: [await stateComment(statePayload(42, 5))] };
    const { deps, logs } = setup([{ number: 5, issue: 42 }], comments, {}, 'timeout');
    expect(await sweepCiPendingDrafts(deps)).toEqual([{ pr: 5, issue: 42, action: 'still-pending' }]);
    expect(deps.markReady).not.toHaveBeenCalled();
    expect(logs[0]?.msg).toBe('PR #5: CI still pending; left as draft');
    expect(await draftOf(comments, 5, 42)).toMatchObject({ draftReason: 'ci-pending' });
  });

  it('treats a throwing probe as still pending', async () => {
    const { deps, logs } = setup(
      [{ number: 5, issue: 42 }],
      { 5: [await stateComment(statePayload(42, 5))] },
      {
        probeCi: async () => {
          throw new Error('boom');
        },
      },
    );
    expect((await sweepCiPendingDrafts(deps))[0]?.action).toBe('still-pending');
    expect(logs[0]?.type).toBe('warn');
  });

  it('leaves a requested draft untouched', async () => {
    const { deps } = setup([{ number: 5, issue: 42 }], {
      5: [await stateComment(statePayload(42, 5, { draftReason: 'requested' }))],
    });
    expect(await sweepCiPendingDrafts(deps)).toEqual([]);
    expect(deps.probeCi).not.toHaveBeenCalled();
  });

  it('leaves a draft with no draftReason untouched', async () => {
    const { draftReason: _omit, ...plain } = statePayload(42, 5);
    const { deps } = setup([{ number: 5, issue: 42 }], { 5: [await stateComment(plain)] });
    expect(await sweepCiPendingDrafts(deps)).toEqual([]);
    expect(deps.probeCi).not.toHaveBeenCalled();
  });

  it('leaves a draft with no trusted run state untouched', async () => {
    const forged = setup([{ number: 5, issue: 42 }], { 5: [await stateComment(statePayload(42, 5), 99)] });
    expect(await sweepCiPendingDrafts(forged.deps)).toEqual([]);
    const none = setup([{ number: 5, issue: 42 }], {});
    expect(await sweepCiPendingDrafts(none.deps)).toEqual([]);
    expect(forged.deps.probeCi).not.toHaveBeenCalled();
    expect(none.deps.probeCi).not.toHaveBeenCalled();
  });

  it('leaves a state recorded for another PR untouched', async () => {
    const { deps } = setup([{ number: 5, issue: 42 }], { 5: [await stateComment(statePayload(42, 6))] });
    expect(await sweepCiPendingDrafts(deps)).toEqual([]);
  });

  it('skips non-draft, non-factory-branch and in-flight PRs', async () => {
    const comments = {
      5: [await stateComment(statePayload(42, 5))],
      6: [await stateComment(statePayload(43, 6))],
      7: [await stateComment(statePayload(44, 7))],
      8: [await stateComment(statePayload(45, 8))],
    };
    const { deps } = setup(
      [
        { number: 5, issue: 42, draft: false },
        { number: 6, issue: 43, ref: 'feature/43-thing' },
        { number: 7, issue: 44 },
        { number: 8, issue: 45, ref: 'factory/no-issue' },
      ],
      comments,
      { protectedIssues: new Set([44]) },
    );
    expect(await sweepCiPendingDrafts(deps)).toEqual([]);
    expect(deps.probeCi).not.toHaveBeenCalled();
  });

  it('skips a draft whose issue is in flight on a lane', async () => {
    const { deps } = setup(
      [{ number: 7, issue: 44 }],
      { 7: [await stateComment(statePayload(44, 7))] },
      {
        protectedIssues: new Set([44]),
      },
    );
    expect(await sweepCiPendingDrafts(deps)).toEqual([]);
  });

  it('never throws when listing fails', async () => {
    const { deps, logs } = setup([], {});
    const broken = Object.assign({} as Octokit, {
      rest: {
        pulls: {
          list: async () => {
            throw new Error('down');
          },
        },
      },
    });
    expect(await sweepCiPendingDrafts({ ...deps, octokit: broken })).toEqual([]);
    expect(logs[0]?.type).toBe('warn');
  });
});

describe('runCiPendingDraftSweep (#3932)', () => {
  const temp = createTempDirs();
  afterEach(() => temp.cleanup());

  it('lands a conflicting CI-pending draft with syncMain so the land conflict path runs', async () => {
    const root = temp.makeSync('ci-pending-sweep-');
    const paths = getFactoryPaths(root);
    const comments = { 5: [await stateComment(statePayload(42, 5))] };
    const { octokit } = fakeOctokit([{ number: 5, issue: 42 }], comments);
    Object.assign(octokit.rest, {
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
        }),
      },
    });
    const graphql = vi.fn(async () => ({}));
    Object.assign(octokit, { graphql });
    const waitMerge = vi.fn<typeof waitForMerge>(async () => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCiPendingDraftSweep(paths, REPO, () => octokit, {
        repoRoot: root,
        autoMerge: true,
        waitMerge,
        lane: 'app',
      });
    } finally {
      log.mockRestore();
    }
    expect(waitMerge).toHaveBeenCalledWith(42, 'factory/42-thing', root, REPO, paths, {
      landBranch: 'factory/42-thing',
      holdWhenGated: true,
      syncMain: true,
      mergeOverrides: { auto: true },
    });
    expect(graphql).toHaveBeenCalledOnce();
    expect(readFileSync(paths.events, 'utf8')).toContain('marked ready');
  });

  it('does nothing without a GitHub client and swallows failures as a warn event', async () => {
    const root = temp.makeSync('ci-pending-sweep-');
    const paths = getFactoryPaths(root);
    await expect(runCiPendingDraftSweep(paths, REPO, () => undefined)).resolves.toBeUndefined();
    const broken = Object.assign({} as Octokit, { rest: {} });
    await runCiPendingDraftSweep(paths, REPO, () => broken);
    expect(readFileSync(join(paths.events), 'utf8')).toContain('CI-pending draft sweep');
  });
});
