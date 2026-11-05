// packages/cli/src/cli/ship-pr-state.test.ts — a run restores its state from the PR on a fresh clone and saves it on each update (#3909)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';
import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue, type EventKind } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import {
  countReviewReworkRuns,
  createFileReviewReworkStore,
  loadPrRunState,
  savePrRunState,
  type PrRunState,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prRunStateRecorder, restorePrRunStateForRun, shipRunStateRecorder } from './ship-pr-state.js';

const SELF = 7;
const REPO = 'o/r';
const BRANCH = 'ship-it/42-thing';
const key = workKeyFromIssue(42);
const SHA = 'abc1234def';

type Stored = { id: number; user: { id: number }; body: string };

function fakeOctokit(opts: { pulls?: unknown[]; listFails?: boolean } = {}): { octokit: Octokit; comments: Stored[] } {
  const comments: Stored[] = [];
  let next = 100;
  const pulls = opts.pulls ?? [{ number: 9, head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } } }];
  const rest = {
    users: { getAuthenticated: async () => ({ data: { id: SELF } }) },
    pulls: {
      list: async () => {
        if (opts.listFails) throw new Error('boom');
        return { data: pulls };
      },
      get: async () => ({ data: { head: { sha: SHA } } }),
    },
    issues: {
      listComments: async ({ page }: { page: number }) => ({ data: page === 1 ? comments : [] }),
      createComment: async ({ body }: { body: string }) => {
        const c = { id: next++, user: { id: SELF }, body };
        comments.push(c);
        return { data: c };
      },
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
        const c = comments.find((x) => x.id === comment_id);
        if (c) c.body = body;
        return { data: c };
      },
    },
  };
  return { octokit: Object.assign({} as Octokit, { rest }), comments };
}

function prState(over: Partial<PrRunState> = {}): PrRunState {
  return {
    version: 1,
    key,
    prNumber: 9,
    status: 'awaiting-review',
    spec: { sha256: 'a'.repeat(64), summary: 'goal' },
    checkRework: { used: 1, cap: 3 },
    reviewRework: { used: 2, cap: 3 },
    handledReviewIds: [11, 12],
    handledCommentIds: [],
    rounds: [],
    updatedAt: '2026-11-04T01:00:00.000Z',
    ...over,
  };
}

describe('ship PR run state', () => {
  let dir: string;
  let reviewReworkFile: string;
  let runsDir: string;
  let events: { kind: EventKind; msg: string }[];
  const log = (kind: EventKind, msg: string): void => {
    events.push({ kind, msg });
  };
  const base = (octokit: Octokit) => ({
    octokit,
    repo: REPO,
    branch: BRANCH,
    issueNum: 42,
    reviewReworkFile,
    runsDir,
    maxReviewReworkRuns: 3,
    log,
  });

  const temp = createTempDirs();
  beforeEach(() => {
    dir = temp.makeSync('pr-state-');
    reviewReworkFile = join(dir, 'state', 'review-rework.json');
    runsDir = join(dir, 'state', 'runs');
    events = [];
  });
  afterEach(() => temp.cleanup());

  it('a fresh clone with no local state restores two handled review rounds and the remaining cap', async () => {
    const { octokit } = fakeOctokit();
    await savePrRunState({ octokit, repo: REPO, prNumber: 9, state: prState() });

    const restored = await restorePrRunStateForRun(base(octokit));

    expect(restored?.prNumber).toBe(9);
    const store = createFileReviewReworkStore(reviewReworkFile);
    expect(store.has(11)).toBe(true);
    expect(store.has(12)).toBe(true);
    expect(countReviewReworkRuns(store, key)).toBe(2);
    expect(events.find((e) => e.kind === 'pr_state_loaded')?.msg).toContain('1 remaining of cap 3');
  });

  it('stops after one round, deletes local state, and resumes from the PR state', async () => {
    const { octokit } = fakeOctokit();
    createFileReviewReworkStore(reviewReworkFile).record({
      reviewId: 11,
      pr: 9,
      issue: 42,
      lane: 'bugfix',
      reviewer: 'bob',
      queuedAt: '2026-11-04T00:00:00.000Z',
      startedAt: '2026-11-04T00:01:00.000Z',
    });
    const specPath = join(dir, 'issue-42.md');
    writeFileSync(specPath, '# Spec\n\n## Goal\n\nDo the thing.\n\n## Files\n\nx\n');
    const record = prRunStateRecorder(async () => {}, {
      octokit,
      repo: REPO,
      issueNum: 42,
      specPath,
      reviewReworkFile,
      runsDir,
      maxReviewReworkRuns: 3,
      log,
    });
    await record({ status: 'checking', prNumber: 9, attempts: 2 });
    expect(events).toEqual([]);

    rmSync(join(dir, 'state'), { recursive: true, force: true });
    const restored = await restorePrRunStateForRun(base(octokit));

    expect(restored?.state.spec.summary).toBe('Do the thing.');
    expect(restored?.state.checkRework.used).toBe(1);
    expect(restored?.state.rounds[0]).toMatchObject({ kind: 'check', headSha: SHA });
    const store = createFileReviewReworkStore(reviewReworkFile);
    expect(store.has(11)).toBe(true);
    expect(countReviewReworkRuns(store, key)).toBe(1);
  });

  it('skips the save when nothing changed and does nothing without a PR number', async () => {
    const { octokit, comments } = fakeOctokit();
    const record = prRunStateRecorder(async () => {}, {
      octokit,
      repo: REPO,
      issueNum: 42,
      specPath: join(dir, 'missing.md'),
      reviewReworkFile,
      runsDir,
      maxReviewReworkRuns: 3,
      log,
    });
    mkdirSync(runsDir, { recursive: true });
    await record({ status: 'building' });
    expect(comments).toHaveLength(0);
    createFileReviewReworkStore(reviewReworkFile).record({
      reviewId: 5,
      pr: 9,
      issue: 42,
      lane: '',
      reviewer: '',
      queuedAt: '2026-11-04T00:00:00.000Z',
    });
    await record({ status: 'building', prNumber: 9 });
    const saved = comments[0]?.body;
    await record({ status: 'building', prNumber: 9 });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(saved);
  });

  it('saves draftReason ci-pending and status awaiting-ci on a CI-pending ready update, and drops it later', async () => {
    const { octokit, comments } = fakeOctokit();
    const record = prRunStateRecorder(async () => {}, {
      octokit,
      repo: REPO,
      issueNum: 42,
      specPath: join(dir, 'missing.md'),
      reviewReworkFile,
      runsDir,
      maxReviewReworkRuns: 3,
      log,
    });
    mkdirSync(runsDir, { recursive: true });
    createFileReviewReworkStore(reviewReworkFile).record({
      reviewId: 5,
      pr: 9,
      issue: 42,
      lane: '',
      reviewer: '',
      queuedAt: '2026-11-04T00:00:00.000Z',
    });
    await record({ status: 'ready', prNumber: 9, draftReason: 'ci-pending' });
    const first = await loadPrRunState({ octokit, repo: REPO, prNumber: 9, key });
    expect(first).toMatchObject({ status: 'found', state: { draftReason: 'ci-pending', status: 'awaiting-ci' } });
    expect(comments).toHaveLength(1);
    await record({ status: 'ready', prNumber: 9 });
    const second = await loadPrRunState({ octokit, repo: REPO, prNumber: 9, key });
    expect(second.status === 'found' && 'draftReason' in second.state).toBe(false);
    expect(second).toMatchObject({ state: { status: 'awaiting-review' } });
  });

  it('logs pr_state_ignored for a forged block and restores nothing', async () => {
    const { octokit, comments } = fakeOctokit();
    await savePrRunState({ octokit, repo: REPO, prNumber: 9, state: prState() });
    if (comments[0]) comments[0].user.id = 999;

    const restored = await restorePrRunStateForRun(base(octokit));

    expect(restored).toBeUndefined();
    expect(events).toEqual([
      {
        kind: 'pr_state_ignored',
        msg: `ignored PR #9 comment ${comments[0]?.id} as factory run state: untrusted-author`,
      },
    ]);
    expect(createFileReviewReworkStore(reviewReworkFile).list()).toEqual([]);
  });

  it('a GitHub failure logs pr_state_failed and never throws', async () => {
    const { octokit } = fakeOctokit({ listFails: true });
    await expect(restorePrRunStateForRun(base(octokit))).resolves.toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(['pr_state_failed']);

    const failing = Object.assign({} as Octokit, {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: SELF } }) },
        pulls: {
          list: async () => ({ data: [{ number: 9, head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } } }] }),
        },
        issues: {
          listComments: async () => {
            throw new Error('comments down');
          },
        },
      },
    });
    events = [];
    await expect(restorePrRunStateForRun(base(failing))).resolves.toBeUndefined();
    expect(events[0]).toMatchObject({ kind: 'pr_state_failed' });
    expect(events[0]?.msg).toContain('comments down');

    const saveFails = prRunStateRecorder(async () => {}, {
      octokit: failing,
      repo: REPO,
      issueNum: 42,
      specPath: join(dir, 'x.md'),
      reviewReworkFile,
      runsDir,
      maxReviewReworkRuns: 3,
      log,
    });
    createFileReviewReworkStore(reviewReworkFile).record({
      reviewId: 5,
      pr: 9,
      issue: 42,
      lane: '',
      reviewer: '',
      queuedAt: '2026-11-04T00:00:00.000Z',
    });
    events = [];
    await expect(saveFails({ status: 'building', prNumber: 9 })).resolves.toBeUndefined();
    expect(events[0]).toMatchObject({ kind: 'pr_state_failed' });
  });

  it('skips when no open PR matches the branch', async () => {
    const { octokit } = fakeOctokit({ pulls: [] });
    expect(await restorePrRunStateForRun(base(octokit))).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('logs pr_state_failed when several open PRs match the branch', async () => {
    const pr = (n: number) => ({ number: n, head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } } });
    const { octokit } = fakeOctokit({ pulls: [pr(9), pr(10)] });
    expect(await restorePrRunStateForRun(base(octokit))).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(['pr_state_failed']);
  });

  it('shipRunStateRecorder keeps the bare local recorder when skipped and saves to the PR otherwise', async () => {
    const { octokit, comments } = fakeOctokit();
    const opts = {
      octokit,
      repo: REPO,
      branch: BRANCH,
      issueNum: 42,
      factoryConfig: { queue: { ...defaultFactoryConfig.queue, max_review_rework_runs: 3 } },
      paths: { reviewRework: reviewReworkFile, runs: runsDir },
      log,
    };
    const base = {
      lane: 'bugfix',
      worktree: dir,
      specPath: join(dir, 'issue-42.md'),
      startedAt: '2026-11-04T00:00:00.000Z',
    };

    const skipped = (await shipRunStateRecorder(true, opts))(base);
    await skipped({ status: 'building', prNumber: 9 });
    expect(comments).toHaveLength(0);

    const persisted = (await shipRunStateRecorder(false, opts))(base);
    await persisted({ status: 'shipping', prNumber: 9, attempts: 1 });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('factory:run-state v1 key:42');
  });
});
