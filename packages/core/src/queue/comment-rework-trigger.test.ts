// packages/core/src/queue/comment-rework-trigger.test.ts — a trusted `/factory rework` PR comment queues one review rework per comment id (#3882).

import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createOctokitCollaboratorPermissionClient } from './approval.js';
import { parseReworkCommand, pollCommentRework } from './comment-rework-trigger.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { IN_PROGRESS_LABEL, laneLabel, PARKED_LABEL, QUEUED_LABEL, type QueueGitHubClient } from './github-queue.js';
import type { IterateComment, IterateCommandGitHub, IteratePull } from './iterate-command.js';
import { claimReviewRework, createFileReviewReworkStore } from './review-rework-trigger.js';

const lane = laneLabel('bugfix');
const cmd = (id: number, login = 'alice', body = '/factory rework rename foo to bar'): IterateComment => ({
  id,
  body,
  login,
  createdAt: '2026-01-01T00:00:00Z',
});
const pr = (number: number, headRef: string, headRepo: string | null = 'o/r'): IteratePull => ({
  number,
  headRef,
  headRepo: headRepo ?? undefined,
});

function setup(opts: {
  pulls: IteratePull[];
  comments: Record<number, IterateComment[]>;
  issues: Record<number, string[]>;
  permissions?: Record<string, string>;
  failList?: number;
}) {
  const state = new Map<number, Set<string>>(Object.entries(opts.issues).map(([n, l]) => [Number(n), new Set(l)]));
  const posted: { pr: number; body: string }[] = [];
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
  const github: IterateCommandGitHub = {
    listOpenPulls: async () => opts.pulls,
    async listComments(n) {
      if (n === opts.failList) throw new Error('list boom');
      return opts.comments[n] ?? [];
    },
    async postComment(n, body) {
      posted.push({ pr: n, body });
    },
  };
  const octokit: Octokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async (p: { username: string }) => ({
          data: { permission: opts.permissions?.[p.username] ?? 'admin' },
        }),
      },
    },
  } as never;
  return { state, queue, github, octokit, posted };
}

describe('parseReworkCommand', () => {
  it.each([
    ['/factory rework rename foo', 'rename foo'],
    ['/factory rework\nrename foo\nand bar', 'rename foo\nand bar'],
    ['\n  /FACTORY Rework   do it  \nmore', 'do it\nmore'],
    ['/factory rework', ''],
    ['/factory reworking', null],
    ['/factory iterate', null],
    ['', null],
    ['please\n/factory rework x', null],
  ])('%j -> %j', (body, expected) => {
    expect(parseReworkCommand(body)).toBe(expected);
  });
});

describe('pollCommentRework', () => {
  const tempDirs = createTempDirs();
  let dir: string;
  beforeEach(() => {
    dir = tempDirs.makeSync('comment-rework-');
  });
  afterEach(() => tempDirs.cleanup());

  const run = (
    env: ReturnType<typeof setup>,
    extra: { store?: ReturnType<typeof createFileReviewReworkStore>; maxRuns?: number } = {},
  ) =>
    pollCommentRework({
      github: env.github,
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      permissions: createOctokitCollaboratorPermissionClient(env.octokit),
      store: extra.store ?? createFileReviewReworkStore(join(dir, 's.json')),
      maxRuns: extra.maxRuns,
    });
  const basic = (
    comments: IterateComment[],
    labels: string[] = [lane],
    extra: Partial<Parameters<typeof setup>[0]> = {},
  ) =>
    setup({ pulls: [pr(900, 'factory/42-fix-thing')], comments: { 900: comments }, issues: { 42: labels }, ...extra });

  it('a trusted /factory rework comment queues one review rework and a second poll does nothing', async () => {
    const env = basic([cmd(5)]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const first = await run(env, { store });
    const second = await run(env, { store });
    expect(first).toMatchObject([{ outcome: 'queued', issue: 42, lane: 'bugfix', reviewIds: [5], reviewer: 'alice' }]);
    expect(second).toEqual([]);
    expect(env.state.get(42)).toContain(QUEUED_LABEL);
    expect(store.list()).toMatchObject([{ reviewId: 5, source: 'comment', pr: 900, issue: 42, lane: 'bugfix' }]);
    expect(env.posted).toHaveLength(1);
    expect(env.posted[0]?.body).toContain("queued #42 on lane 'bugfix'");
    expect(env.posted[0]?.body).toContain('factory/42-fix-thing');
    expect(claimReviewRework(store, 42)).toMatchObject({ reviewId: 5, source: 'comment' });
  });

  it('acts once on the newest of several trusted rework comments', async () => {
    const env = basic([cmd(5), cmd(7, 'bob'), cmd(6, 'alice', 'hello')]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const res = await run(env, { store });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ outcome: 'queued', reviewer: 'bob', reviewIds: [5, 7] });
    expect(store.list().map((r) => r.reviewId)).toEqual([5, 7]);
    expect(env.posted).toHaveLength(1);
    expect(await run(env, { store })).toEqual([]);
  });

  it("an untrusted author's /factory rework comment queues nothing, records nothing and posts nothing", async () => {
    const env = basic([cmd(5, 'mallory')], [lane], { permissions: { mallory: 'read' } });
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    expect(await run(env, { store })).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(env.posted).toEqual([]);
    expect(env.state.get(42)).not.toContain(QUEUED_LABEL);
  });

  it('a bare /factory rework is rejected with a reply and never claimed', async () => {
    const env = basic([cmd(5, 'alice', '/factory rework')]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    const [res] = await run(env, { store });
    expect(res).toMatchObject({ outcome: 'skipped', detail: 'no feedback' });
    expect(env.posted[0]?.body).toBe('Factory rework: rejected — add the feedback after `/factory rework`.');
    expect(claimReviewRework(store, 42)).toBeUndefined();
    expect(store.list()[0]?.startedAt).toBeUndefined();
    expect(await run(env, { store })).toEqual([]);
  });

  it('at the rework limit a trusted comment parks with the cap message, replies on the PR and queues nothing', async () => {
    const env = basic([cmd(9)]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    for (const id of [1, 2]) {
      store.record({
        reviewId: id,
        pr: 900,
        issue: 42,
        lane: 'bugfix',
        reviewer: 'bob',
        queuedAt: 'x',
        startedAt: 'y',
      });
    }
    const [res] = await run(env, { store });
    expect(res).toMatchObject({ outcome: 'capped', cap: 2, count: 2, lane: 'bugfix' });
    expect(env.state.get(42)).toContain(PARKED_LABEL);
    expect(env.state.get(42)).not.toContain(QUEUED_LABEL);
    expect(env.posted[0]?.body).toContain('review-rework limit (2/2, queue.max_review_rework_runs)');
    expect(claimReviewRework(store, 42)).toBeUndefined();
    expect(await run(env, { store })).toEqual([]);
  });

  it('a started comment rework counts toward the same cap as review reworks', async () => {
    const env = basic([cmd(5)]);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    expect((await run(env, { store }))[0]?.outcome).toBe('queued');
    claimReviewRework(store, 42);
    env.state.set(42, new Set([lane]));
    env.github.listComments = async () => [cmd(6)];
    expect((await run(env, { store, maxRuns: 1 }))[0]).toMatchObject({ outcome: 'capped', count: 1, cap: 1 });
  });

  it.each([
    ['claimed', [lane, IN_PROGRESS_LABEL]],
    ['parked', [lane, PARKED_LABEL]],
    ['no lane label', []],
    ['several lane labels: bugfix, other', [lane, laneLabel('other')]],
  ])('skips when %s and records nothing', async (detail, labels) => {
    const env = basic([cmd(5)], labels);
    const store = createFileReviewReworkStore(join(dir, 's.json'));
    expect(await run(env, { store })).toMatchObject([{ outcome: 'skipped', detail }]);
    expect(store.list()).toEqual([]);
  });

  it('ignores non-factory and fork heads, and one PR failing does not stop the others', async () => {
    const env = setup({
      pulls: [pr(1, 'feature/x'), pr(2, 'factory/42-a', 'evil/r'), pr(3, 'factory/43-b'), pr(4, 'factory/44-c')],
      comments: { 1: [cmd(1)], 2: [cmd(2)], 3: [cmd(3)], 4: [cmd(4)] },
      issues: { 43: [lane], 44: [lane] },
      failList: 3,
    });
    const res = await run(env);
    expect(res.map((r) => [r.pr, r.outcome])).toEqual([
      [3, 'error'],
      [4, 'queued'],
    ]);
  });
});
