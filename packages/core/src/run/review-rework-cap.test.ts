// packages/core/src/run/review-rework-cap.test.ts — review-rework runs are capped per issue; the cap parks with one comment (#3565).

import { join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { fakeIssueComments } from '../queue/fake-issue-comments.js';
import { laneLabel, PARKED_LABEL, QUEUED_LABEL, type QueueGitHubClient } from '../queue/github-queue.js';
import {
  claimReviewRework,
  createFileReviewReworkStore,
  pollReviewRework,
  type ReviewReworkRecord,
  type ReviewReworkReview,
} from '../queue/review-rework-trigger.js';
import {
  countReviewReworkRuns,
  parkAtReviewReworkCap,
  resolveMaxReviewReworkRuns,
  reviewReworkCapMessage,
} from './review-rework-cap.js';

const ISSUE = 42;
const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const rec = (reviewId: number, extra: Partial<ReviewReworkRecord> = {}, issue = ISSUE): ReviewReworkRecord => ({
  reviewId,
  pr: 900,
  issue,
  lane: 'bugfix',
  reviewer: 'alice',
  queuedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const started = { startedAt: '2026-01-01T01:00:00.000Z' };

function fakeQueue(labels: string[]) {
  const set = new Set(labels);
  const comments = fakeIssueComments();
  const queue: QueueGitHubClient = {
    async listOpenIssuesWithLabels() {
      return [];
    },
    async getIssueLabels() {
      return [...set];
    },
    async addLabels({ labels: added }) {
      for (const l of added) set.add(l);
    },
    async removeLabel({ name }) {
      set.delete(name);
    },
    ...comments,
    async ensureLabel() {
      return false;
    },
  };
  return { queue, set, comments };
}

function setup(priorRecords: ReviewReworkRecord[], reviews: ReviewReworkReview[]) {
  const store = createFileReviewReworkStore(join(dirs.makeSync('cap-'), 's.json'));
  for (const r of priorRecords) store.record(r);
  const env = fakeQueue([laneLabel('bugfix')]);
  const poll = (maxRuns?: number, publishParkComment?: Parameters<typeof pollReviewRework>[0]['publishParkComment']) =>
    pollReviewRework({
      github: {
        listOpenPulls: async () => [{ number: 900, headRef: 'factory/42-fix-thing', headRepo: 'o/r' }],
        listReviews: async () => reviews,
      },
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      trustedApprovers: ['alice'],
      permissions: { getCollaboratorPermissionLevel: async () => 'write' } as never,
      store,
      maxRuns,
      publishParkComment,
    });
  return { store, env, poll };
}

const changes = (id: number): ReviewReworkReview => ({ id, state: 'CHANGES_REQUESTED', login: 'alice' });
const comments = (env: ReturnType<typeof fakeQueue>) =>
  env.comments.listIssueComments({ owner: 'o', repo: 'r', issue_number: ISSUE });

describe('review-rework cap (#3565)', () => {
  it('a third changes-requested review parks the issue at the default cap', async () => {
    const { store, env, poll } = setup([rec(1, started), rec(2, started)], [changes(3)]);
    const [res] = await poll();
    expect(res).toMatchObject({ outcome: 'capped', cap: 2, count: 2, issue: ISSUE, reviewIds: [3] });
    expect(env.set.has(QUEUED_LABEL)).toBe(false);
    expect(env.set.has(PARKED_LABEL)).toBe(true);
    const posted = await comments(env);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain('cap 2');
    expect(posted[0]?.body).toContain('2 review-rework runs');
    expect(claimReviewRework(store, ISSUE)).toBeUndefined();
  });

  it('a later review on the capped issue adds no second comment', async () => {
    const { env, poll } = setup([rec(1, started), rec(2, started)], [changes(3)]);
    await poll();
    const again = setup([rec(1, started), rec(2, started)], [changes(4)]);
    again.env.set.add(PARKED_LABEL);
    const [res] = await again.poll();
    expect(res).toMatchObject({ outcome: 'skipped', detail: 'parked' });
    expect(await comments(again.env)).toHaveLength(0);
    expect(await comments(env)).toHaveLength(1);
  });

  it('a capped review is recorded and never re-triggers', async () => {
    const { env, poll } = setup([rec(1, started), rec(2, started)], [changes(3)]);
    await poll();
    env.set.delete(PARKED_LABEL);
    expect(await poll()).toEqual([]);
    expect(await comments(env)).toHaveLength(1);
  });

  it('below the cap a review still queues', async () => {
    const { poll } = setup([rec(1, started)], [changes(3)]);
    const [res] = await poll();
    expect(res?.outcome).toBe('queued');
  });

  it('a configured maxRuns overrides the default', async () => {
    const roomy = setup([rec(1, started), rec(2, started)], [changes(3)]);
    expect((await roomy.poll(3))[0]?.outcome).toBe('queued');
    const zero = setup([], [changes(3)]);
    expect((await zero.poll(0))[0]).toMatchObject({ outcome: 'capped', cap: 0, count: 0 });
  });

  it('a failing park comment surfaces as an error outcome', async () => {
    const { poll } = setup([rec(1, started), rec(2, started)], [changes(3)]);
    const [res] = await poll(undefined, async () => ({ ok: false, error: 'gh down' }));
    expect(res).toMatchObject({ outcome: 'error', detail: 'gh down' });
  });

  it('countReviewReworkRuns counts only started records for the issue', () => {
    const store = createFileReviewReworkStore(join(dirs.makeSync('count-'), 's.json'));
    store.record(rec(1, started));
    store.record(rec(2));
    store.record(rec(3, { cappedAt: '2026-01-02T00:00:00.000Z' }));
    store.record(rec(4, started, 7));
    expect(countReviewReworkRuns(store, ISSUE)).toBe(1);
  });

  it('resolveMaxReviewReworkRuns returns the default and an override', () => {
    expect(resolveMaxReviewReworkRuns(defaultFactoryConfig as never)).toBe(2);
    expect(resolveMaxReviewReworkRuns({ queue: { max_review_rework_runs: 5 } } as never)).toBe(5);
    expect(resolveMaxReviewReworkRuns({} as never)).toBe(2);
  });

  it('parkAtReviewReworkCap uses the publishComment port and throws on { ok: false }', async () => {
    const env = fakeQueue([]);
    const deps = {
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      issue: ISSUE,
      pr: 900,
      lane: 'bugfix',
      branch: 'factory/42-fix-thing',
      cap: 2,
      count: 2,
      reviewIds: [3, 4],
    };
    const seen: string[] = [];
    await parkAtReviewReworkCap({
      ...deps,
      publishComment: async (input) => {
        seen.push(input.message);
        return { ok: true };
      },
    });
    expect(seen).toEqual([reviewReworkCapMessage(deps)]);
    expect(await comments(env)).toHaveLength(0);
    await expect(
      parkAtReviewReworkCap({ ...deps, publishComment: async () => ({ ok: false, error: 'nope' }) }),
    ).rejects.toThrow('nope');
  });
});
