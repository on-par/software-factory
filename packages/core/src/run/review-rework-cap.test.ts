// packages/core/src/run/review-rework-cap.test.ts — the per-issue review-rework cap parks with one comment naming it (#3565).

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { fakeIssueComments } from '../queue/fake-issue-comments.js';
import { laneLabel, PARKED_LABEL, type QueueGitHubClient } from '../queue/github-queue.js';
import {
  claimReviewRework,
  createFileReviewReworkStore,
  pollReviewRework,
  type ReviewReworkRecord,
  type ReviewReworkStore,
} from '../queue/review-rework-trigger.js';
import {
  countReviewReworkRuns,
  parkAtReviewReworkCap,
  resolveMaxReviewReworkRuns,
  reviewReworkCapMessage,
} from './review-rework-cap.js';
import { loadFactoryConfig } from '../config/index.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const rec = (reviewId: number, issue: number, startedAt?: string): ReviewReworkRecord => ({
  reviewId,
  pr: 900,
  issue,
  lane: 'bugfix',
  reviewer: 'alice',
  queuedAt: '2026-01-01T00:00:00.000Z',
  ...(startedAt ? { startedAt } : {}),
});

function env(startedRuns: number, extraReviews: { id: number; state: string; login: string }[] = []) {
  const store: ReviewReworkStore = createFileReviewReworkStore(join(dirs.makeSync('cap-'), 's.json'));
  for (let i = 1; i <= startedRuns; i++) store.record(rec(i, 42, '2026-01-02T00:00:00.000Z'));
  const labels = new Set<string>([laneLabel('bugfix')]);
  const added: string[][] = [];
  const comments = fakeIssueComments();
  let commentCalls = 0;
  const queue: QueueGitHubClient = {
    async listOpenIssuesWithLabels() {
      return [];
    },
    async getIssueLabels() {
      return [...labels];
    },
    async addLabels({ labels: l }) {
      added.push(l);
      for (const x of l) labels.add(x);
    },
    async removeLabel() {},
    async ensureLabel() {
      return false;
    },
    ...comments,
    async createIssueComment(input) {
      commentCalls++;
      return comments.createIssueComment(input);
    },
  };
  const reviews = [{ id: 100, state: 'CHANGES_REQUESTED', login: 'bob' }, ...extraReviews];
  const poll = (opts: { maxRuns?: number } = {}) =>
    pollReviewRework({
      github: {
        listOpenPulls: async () => [{ number: 900, headRef: 'factory/42-fix', headRepo: 'o/r' }],
        listReviews: async () => reviews,
      },
      queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      permissions: { getPermissionLevel: async () => 'write' },
      trustedApprovers: ['bob'],
      store,
      ...opts,
    });
  return {
    queue,
    store,
    labels,
    added,
    poll,
    comments: () => comments.listIssueComments({ owner: 'o', repo: 'r', issue_number: 42 }),
    commentCalls: () => commentCalls,
  };
}

describe('review-rework cap (#3565)', () => {
  it('a third changes-requested review parks the issue at the default cap', async () => {
    const e = env(2);
    const [res] = await e.poll();
    expect(res).toMatchObject({ outcome: 'capped', cap: 2, count: 2, issue: 42, lane: 'bugfix' });
    expect(e.added).toEqual([[PARKED_LABEL]]);
    expect(e.labels.has('factory:queued')).toBe(false);
    expect(claimReviewRework(e.store, 42)).toBeUndefined();
    const comments = await e.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('cap 2');
    expect(comments[0]?.body).toContain('2 review-rework runs');
  });

  it('a second poll after the cap park does not comment again', async () => {
    const e = env(2);
    await e.poll();
    await e.poll();
    expect(e.commentCalls()).toBe(1);
  });

  it('below the cap a changes-requested review still queues', async () => {
    const [res] = await env(1).poll();
    expect(res?.outcome).toBe('queued');
  });

  it('a configured maxRuns overrides the default', async () => {
    expect((await env(2).poll({ maxRuns: 3 }))[0]?.outcome).toBe('queued');
    expect((await env(0).poll({ maxRuns: 0 }))[0]?.outcome).toBe('capped');
  });
});

describe('review-rework cap helpers', () => {
  it('countReviewReworkRuns counts only started records for the issue', () => {
    const store = { list: () => [rec(1, 42, 'x'), rec(2, 42), rec(3, 7, 'x')] };
    expect(countReviewReworkRuns(store, workKeyFromIssue(42))).toBe(1);
  });

  it('resolveMaxReviewReworkRuns reads the config, else 2', () => {
    const config = loadFactoryConfig();
    expect(resolveMaxReviewReworkRuns(config)).toBe(2);
    expect(resolveMaxReviewReworkRuns({ queue: { ...config.queue, max_review_rework_runs: 4 } })).toBe(4);
    expect(resolveMaxReviewReworkRuns({} as never)).toBe(2);
  });

  it('reviewReworkCapMessage names the cap and the count', () => {
    const msg = reviewReworkCapMessage({ issue: workKeyFromIssue(42), pr: 900, cap: 2, count: 3, reviewIds: [7, 8] });
    expect(msg).toContain('3 review-rework runs (cap 2');
    expect(msg).toContain('PR #900');
    expect(msg).toContain('factory unpark 42');
  });

  describe('parkAtReviewReworkCap', () => {
    const base = {
      owner: 'o',
      repo: 'r',
      issue: workKeyFromIssue(42),
      pr: 900,
      lane: 'bugfix',
      branch: 'b',
      cap: 2,
      count: 2,
      reviewIds: [1],
    };
    it('publishes through publishComment when given', async () => {
      const e = env(0);
      const inputs: unknown[] = [];
      await parkAtReviewReworkCap({
        ...base,
        queue: e.queue,
        publishComment: async (i) => {
          inputs.push(i);
          return { ok: true };
        },
      });
      expect(inputs).toMatchObject([{ issue: workKeyFromIssue(42), reason: 'escalate' }]);
      expect(e.commentCalls()).toBe(0);
    });

    it('throws when publishComment returns ok:false', async () => {
      const e = env(0);
      await expect(
        parkAtReviewReworkCap({
          ...base,
          queue: e.queue,
          publishComment: async () => ({ ok: false, error: 'nope' }),
        }),
      ).rejects.toThrow(/nope/);
    });

    it('falls back to createIssueComment', async () => {
      const e = env(0);
      await parkAtReviewReworkCap({ ...base, queue: e.queue });
      expect(e.commentCalls()).toBe(1);
    });
  });
});
