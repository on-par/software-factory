// packages/core/src/queue/review-rework-trigger.test.ts — a trusted changes-requested review queues its issue once per review id (#3563).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createOctokitCollaboratorPermissionClient } from './approval.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { IN_PROGRESS_LABEL, laneLabel, PARKED_LABEL, QUEUED_LABEL, type QueueGitHubClient } from './github-queue.js';
import {
  claimReviewRework,
  createFileReviewReworkStore,
  createOctokitReviewReworkGitHub,
  latestDecisiveReviews,
  pollReviewRework,
  type ReviewReworkReview,
} from './review-rework-trigger.js';

interface FakePull {
  number: number;
  head: { ref: string; repo: { full_name: string } | null };
}
interface FakeReview {
  id: number;
  state: string;
  user: { login: string } | null;
  submitted_at?: string;
}

function setup(opts: {
  pulls: FakePull[];
  reviews: Record<number, FakeReview[]>;
  issues: Record<number, string[]>;
  permissions?: Record<string, string>;
  failAdd?: boolean;
}) {
  const state = new Map<number, Set<string>>(Object.entries(opts.issues).map(([n, l]) => [Number(n), new Set(l)]));
  let addCalls = 0;
  const queue: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      return [...state]
        .filter(([, set]) => labels.every((l) => set.has(l)))
        .map(([number, set]) => ({ number, labels: [...set] }));
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      addCalls++;
      if (opts.failAdd) throw new Error('add boom');
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  const octokit: Octokit = {
    rest: {
      pulls: {
        list: async () => ({ data: opts.pulls }),
        listReviews: async (p: { pull_number: number }) => ({ data: opts.reviews[p.pull_number] ?? [] }),
      },
      repos: {
        getCollaboratorPermissionLevel: async (p: { username: string }) => ({
          data: { permission: opts.permissions?.[p.username] ?? 'write' },
        }),
      },
    },
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  } as never;
  return { state, queue, octokit, addCalls: () => addCalls };
}

const pull = (number: number, ref: string, repo: string | null = 'o/r'): FakePull => ({
  number,
  head: { ref, repo: repo === null ? null : { full_name: repo } },
});
const review = (id: number, state: string, login: string): FakeReview => ({ id, state, user: { login } });
const lane = laneLabel('bugfix');

describe('pollReviewRework', () => {
  const tempDirs = createTempDirs();
  let dir: string;
  beforeEach(() => {
    dir = tempDirs.makeSync('review-rework-');
  });
  afterEach(() => tempDirs.cleanup());

  const run = (
    env: ReturnType<typeof setup>,
    trustedApprovers?: string[],
    store = createFileReviewReworkStore(join(dir, 's.json')),
  ) =>
    pollReviewRework({
      github: createOctokitReviewReworkGitHub(env.octokit, 'o', 'r'),
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      trustedApprovers,
      permissions: createOctokitCollaboratorPermissionClient(env.octokit),
      store,
    });
  const basic = (reviews: FakeReview[], labels: string[] = [lane], extra: Partial<Parameters<typeof setup>[0]> = {}) =>
    setup({ pulls: [pull(900, 'factory/42-fix-thing')], reviews: { 900: reviews }, issues: { 42: labels }, ...extra });

  it('a trusted changes-requested review queues its issue once', async () => {
    const env = basic([
      review(1, 'CHANGES_REQUESTED', 'mallory'),
      review(2, 'APPROVED', 'alice'),
      review(3, 'CHANGES_REQUESTED', 'trusted-rev'),
    ]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const first = await run(env, ['trusted-rev', 'alice'], store);
    const addsAfterFirst = env.addCalls();
    const second = await run(env, ['trusted-rev', 'alice'], store);

    const queued = [...first, ...second].filter((r) => r.outcome === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ issue: 42, lane: 'bugfix', reviewIds: [3] });
    const labels = [...(env.state.get(42) ?? [])];
    expect(labels).toContain(QUEUED_LABEL);
    expect(labels.filter((l) => l.startsWith('factory:order:'))).toHaveLength(1);
    expect(store.list()).toMatchObject([{ reviewId: 3, pr: 900, issue: 42, lane: 'bugfix' }]);
    expect(store.has(1)).toBe(false);
    expect(env.addCalls()).toBe(addsAfterFirst);
  });

  it('an untrusted changes-requested review (not listed, not admin) queues nothing', async () => {
    const env = basic([review(1, 'CHANGES_REQUESTED', 'mallory')], [lane], { permissions: { mallory: 'write' } });
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    expect(await run(env, undefined, store)).toEqual([]);
    expect(env.addCalls()).toBe(0);
    expect(store.list()).toEqual([]);

    const admin = basic([review(5, 'CHANGES_REQUESTED', 'boss')], [lane], { permissions: { boss: 'admin' } });
    const res = await run(admin, undefined, store);
    expect(res[0]).toMatchObject({ outcome: 'queued', reviewIds: [5] });
  });

  it('approvals and comment-only reviews queue nothing', async () => {
    const env = basic([review(1, 'APPROVED', 'alice'), review(2, 'COMMENTED', 'alice'), review(3, 'COMMENTED', 'bob')]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    expect(await run(env, ['alice', 'bob'], store)).toEqual([]);
    expect(env.addCalls()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('a review id that already queued rework never queues again, even after the queue labels are gone', async () => {
    const env = basic([review(3, 'CHANGES_REQUESTED', 'alice')]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    await run(env, ['alice'], store);
    const adds = env.addCalls();
    for (const l of env.state.get(42) ?? [])
      if (l === QUEUED_LABEL || l.startsWith('factory:order:')) env.state.get(42)?.delete(l);
    expect(await run(env, ['alice'], store)).toEqual([]);
    expect(env.addCalls()).toBe(adds);
    // a fresh store instance reads the persisted file
    expect(createFileReviewReworkStore(join(dir, 's.json')).has(3)).toBe(true);
  });

  it('ignores non-factory branches and fork heads', async () => {
    const env = setup({
      pulls: [pull(1, 'feature/42-x'), pull(2, 'factory/42-x', 'fork/r'), pull(3, 'factory/42-x', null)],
      reviews: {
        1: [review(1, 'CHANGES_REQUESTED', 'a')],
        2: [review(2, 'CHANGES_REQUESTED', 'a')],
        3: [review(3, 'CHANGES_REQUESTED', 'a')],
      },
      issues: { 42: [lane] },
    });
    expect(await run(env, ['a'])).toEqual([]);
    expect(env.addCalls()).toBe(0);
  });

  it.each([
    ['claimed', [lane, IN_PROGRESS_LABEL]],
    ['parked', [lane, PARKED_LABEL]],
    ['no lane label', []],
    ['several lane labels: bugfix, feature', [lane, laneLabel('feature')]],
  ])('skips and does not record (%s)', async (detail, labels) => {
    const env = basic([review(3, 'CHANGES_REQUESTED', 'a')], labels);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const res = await run(env, ['a'], store);
    expect(res).toMatchObject([{ outcome: 'skipped', detail }]);
    expect(store.list()).toEqual([]);
    expect(env.addCalls()).toBe(0);
  });

  it('an enqueue failure is an error result and records nothing', async () => {
    const env = basic([review(3, 'CHANGES_REQUESTED', 'a')], [lane], { failAdd: true });
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const res = await run(env, ['a'], store);
    expect(res).toMatchObject([{ outcome: 'error' }]);
    expect(store.list()).toEqual([]);
  });

  it('two trusted reviewers give one enqueue and two records', async () => {
    const env = basic([review(3, 'CHANGES_REQUESTED', 'a'), review(4, 'CHANGES_REQUESTED', 'b')]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const res = await run(env, ['a', 'b'], store);
    expect(res).toMatchObject([{ outcome: 'queued', reviewIds: [3, 4], reviewer: 'a' }]);
    expect(store.list().map((r) => r.reviewId)).toEqual([3, 4]);
  });

  it('a per-PR failure does not stop other PRs', async () => {
    const env = setup({
      pulls: [pull(1, 'factory/41-x'), pull(900, 'factory/42-fix-thing')],
      reviews: { 900: [review(3, 'CHANGES_REQUESTED', 'a')] },
      issues: { 41: [lane], 42: [lane] },
    });
    const github = createOctokitReviewReworkGitHub(env.octokit, 'o', 'r');
    const res = await pollReviewRework({
      github: {
        listOpenPulls: github.listOpenPulls,
        listReviews: async (n) => {
          if (n === 1) throw new Error('reviews down');
          return github.listReviews(n);
        },
      },
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      trustedApprovers: ['a'],
      permissions: createOctokitCollaboratorPermissionClient(env.octokit),
      store: createFileReviewReworkStore(join(dir, 's.json')),
    });
    expect(res.map((r) => r.outcome)).toEqual(['error', 'queued']);
  });

  it('reads a corrupt or wrong-shape store file as empty', () => {
    const file = join(dir, 'nested', 'bad.json');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(file, '{not json');
    expect(createFileReviewReworkStore(file).list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ reviews: [{ reviewId: 'x' }, 3] }));
    expect(createFileReviewReworkStore(file).list()).toEqual([]);
    writeFileSync(file, '[]');
    expect(createFileReviewReworkStore(file).has(1)).toBe(false);
  });
});

describe('latestDecisiveReviews', () => {
  const r = (id: number, state: string, login = 'A'): ReviewReworkReview => ({ id, state, login });
  it('lets a later approval supersede a changes request', () => {
    expect(latestDecisiveReviews([r(1, 'CHANGES_REQUESTED'), r(2, 'APPROVED', 'a')]).map((x) => x.id)).toEqual([2]);
  });
  it('keeps a changes request across a later comment', () => {
    expect(latestDecisiveReviews([r(1, 'CHANGES_REQUESTED'), r(2, 'COMMENTED')]).map((x) => x.id)).toEqual([1]);
  });
  it('lets a dismissal supersede', () => {
    expect(latestDecisiveReviews([r(1, 'CHANGES_REQUESTED'), r(2, 'DISMISSED')]).map((x) => x.state)).toEqual([
      'DISMISSED',
    ]);
  });
  it('ignores PENDING, unknown states and empty logins', () => {
    expect(latestDecisiveReviews([r(1, 'PENDING'), r(2, 'WEIRD'), r(3, ''), r(4, 'APPROVED', '')])).toEqual([]);
  });
});

describe('claimReviewRework (#3564)', () => {
  const dirs = createTempDirs();
  afterEach(() => dirs.cleanup());
  const rec = (reviewId: number, issue: number, queuedAt: string, startedAt?: string) => ({
    reviewId,
    pr: 9,
    issue,
    lane: 'bugfix',
    reviewer: 'alice',
    queuedAt,
    ...(startedAt ? { startedAt } : {}),
  });

  it('claims the newest unstarted record for the issue and persists startedAt', () => {
    const file = join(dirs.makeSync('claim-'), 's.json');
    const store = createFileReviewReworkStore(file);
    store.record(rec(1, 42, '2026-01-01T00:00:00.000Z'));
    store.record(rec(2, 42, '2026-01-02T00:00:00.000Z'));
    store.record(rec(4, 42, '2026-01-03T00:00:00.000Z', '2026-01-03T01:00:00.000Z'));
    store.record(rec(5, 7, '2026-01-04T00:00:00.000Z'));
    const now = () => new Date('2026-02-01T00:00:00.000Z');
    expect(claimReviewRework(store, 42, now)).toMatchObject({ reviewId: 2, startedAt: '2026-02-01T00:00:00.000Z' });
    const reread = createFileReviewReworkStore(file);
    expect(reread.list().find((r) => r.reviewId === 2)?.startedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(claimReviewRework(reread, 42, now)?.reviewId).toBe(1);
    expect(claimReviewRework(reread, 42, now)).toBeUndefined();
  });

  it('breaks a queuedAt tie by the highest review id and ignores an unknown id', () => {
    const store = createFileReviewReworkStore(join(dirs.makeSync('claim-'), 's.json'));
    store.record(rec(1, 42, '2026-01-01T00:00:00.000Z'));
    store.record(rec(3, 42, '2026-01-01T00:00:00.000Z'));
    store.markStarted(99, 'x');
    expect(claimReviewRework(store, 42)?.reviewId).toBe(3);
  });

  it('never claims a record the cap parked (#3565)', () => {
    const store = createFileReviewReworkStore(join(dirs.makeSync('claim-'), 'cap.json'));
    store.record({ ...rec(1, 42, '2026-01-01T00:00:00.000Z'), cappedAt: '2026-01-01T00:00:00.000Z' });
    expect(claimReviewRework(store, 42)).toBeUndefined();
  });

  it('returns undefined when nothing is pending', () => {
    expect(
      claimReviewRework(createFileReviewReworkStore(join(dirs.makeSync('claim-'), 'none.json')), 42),
    ).toBeUndefined();
  });
});
