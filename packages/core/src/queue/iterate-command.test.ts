// packages/core/src/queue/iterate-command.test.ts — a trusted `/factory iterate` comment queues its issue once per comment id (#3625).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createOctokitCollaboratorPermissionClient } from './approval.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { IN_PROGRESS_LABEL, laneLabel, PARKED_LABEL, type QueueGitHubClient } from './github-queue.js';
import {
  claimIterateCommand,
  createFileIterateStore,
  parseFactoryCommand,
  pollIterateCommands,
  type IterateComment,
  type IterateCommandGitHub,
  type IterateCommandRecord,
  type IteratePull,
} from './iterate-command.js';

const lane = laneLabel('bugfix');
const cmd = (id: number, login = 'alice', body = '/factory iterate'): IterateComment => ({
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
  failAdd?: boolean;
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

describe('parseFactoryCommand', () => {
  it.each([
    ['/factory iterate', 'iterate'],
    ['  /factory iterate  \n', 'iterate'],
    ['\n\n/factory iterate\nthanks', 'iterate'],
    ['/FACTORY Iterate', 'iterate'],
    ['', null],
    ['   \n ', null],
    ['/factory', null],
    ['/factory iterate now', null],
    ['/factory  iterate', null],
    ['/factory unknown', null],
    ['> /factory iterate', null],
    ['please\n/factory iterate', null],
    ['```\n/factory iterate\n```', null],
    ["Factory iterate: queued #42 on lane 'bugfix'.", null],
  ])('%j -> %s', (body, expected) => {
    expect(parseFactoryCommand(body)).toBe(expected);
  });
});

describe('pollIterateCommands', () => {
  const tempDirs = createTempDirs();
  let dir: string;
  beforeEach(() => {
    dir = tempDirs.makeSync('iterate-');
  });
  afterEach(() => tempDirs.cleanup());

  const run = (env: ReturnType<typeof setup>, trustedApprovers?: string[]) =>
    pollIterateCommands({
      github: env.github,
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      trustedApprovers,
      permissions: createOctokitCollaboratorPermissionClient(env.octokit),
      store: createFileIterateStore(join(dir, 's.json')),
    });
  const basic = (
    comments: IterateComment[],
    labels: string[] = [lane],
    extra: Partial<Parameters<typeof setup>[0]> = {},
  ) =>
    setup({ pulls: [pr(900, 'factory/42-fix-thing')], comments: { 900: comments }, issues: { 42: labels }, ...extra });

  it('a trusted comment queues once, posts a queued receipt, and a second poll does nothing', async () => {
    const env = basic([cmd(5)]);
    const first = await run(env);
    expect(first).toMatchObject([
      { pr: 900, issue: 42, commentId: 5, outcome: 'queued', lane: 'bugfix', actor: 'alice' },
    ]);
    expect(env.state.get(42)?.has('factory:queued')).toBe(true);
    expect(env.posted).toHaveLength(1);
    expect(env.posted[0]?.body).toMatch(/^Factory iterate: queued #42 on lane 'bugfix'/);
    expect(await run(env)).toEqual([]);
    expect(env.posted).toHaveLength(1);
  });

  it('a claimed issue is rejected with one receipt comment and no enqueue', async () => {
    const env = basic([cmd(5)], [lane, IN_PROGRESS_LABEL]);
    const res = await run(env);
    expect(res).toMatchObject([{ outcome: 'rejected', detail: 'in-progress' }]);
    expect(env.posted).toHaveLength(1);
    expect(env.posted[0]?.body).toMatch(/^Factory iterate: rejected — a run is already in progress/);
    expect(env.state.get(42)?.has('factory:queued')).toBe(false);
    expect(await run(env)).toEqual([]);
    expect(env.posted).toHaveLength(1);
  });

  it('an untrusted author queues nothing and posts no receipt', async () => {
    const env = basic([cmd(5, 'mallory')], [lane], { permissions: { mallory: 'read' } });
    expect(await run(env)).toEqual([]);
    expect(env.posted).toEqual([]);
    expect(env.state.get(42)?.has('factory:queued')).toBe(false);
    expect(await run(env)).toEqual([]);
  });

  it('honours an explicit trustedApprovers list', async () => {
    const env = basic([cmd(5, 'alice'), cmd(6, 'bob')]);
    const res = await run(env, ['bob']);
    expect(res).toMatchObject([{ commentId: 6, outcome: 'queued', actor: 'bob' }]);
  });

  it('ignores non-factory branches and fork heads (only open PRs are listed)', async () => {
    const env = setup({
      pulls: [pr(1, 'feature/x'), pr(2, 'factory/43-y', 'fork/r'), pr(3, 'factory/44-z', null)],
      comments: { 1: [cmd(1)], 2: [cmd(2)], 3: [cmd(3)] },
      issues: { 42: [lane], 43: [lane], 44: [lane] },
    });
    expect(await run(env)).toEqual([]);
    expect(env.posted).toEqual([]);
  });

  it('a parked issue is unparked and queued', async () => {
    const env = basic([cmd(5)], [lane, PARKED_LABEL]);
    expect(await run(env)).toMatchObject([{ outcome: 'queued' }]);
    expect(env.state.get(42)?.has(PARKED_LABEL)).toBe(false);
  });

  it('no lane label / several lane labels -> rejected receipt', async () => {
    const none = basic([cmd(5)], []);
    expect(await run(none)).toMatchObject([{ outcome: 'rejected', detail: 'no lane label' }]);
    expect(none.posted[0]?.body).toContain('no lane label');
    const many = basic([cmd(6)], [lane, laneLabel('feature')]);
    expect(await run(many)).toMatchObject([{ outcome: 'rejected', detail: 'several lane labels: bugfix, feature' }]);
    expect(many.posted).toHaveLength(1);
  });

  it('an enqueue failure -> error, nothing recorded, and a later poll retries', async () => {
    const env = basic([cmd(5)], [lane], { failAdd: true });
    const store = createFileIterateStore(join(dir, 'e.json'));
    const opts = {
      github: env.github,
      queue: env.queue,
      owner: 'o',
      repo: 'r',
      branchPrefix: 'factory',
      permissions: createOctokitCollaboratorPermissionClient(env.octokit),
      store,
    };
    expect(await pollIterateCommands(opts)).toMatchObject([{ outcome: 'error' }]);
    expect(store.list()).toEqual([]);
    expect(env.posted).toEqual([]);
  });

  it('a per-PR failure does not stop other PRs', async () => {
    const env = setup({
      pulls: [pr(900, 'factory/42-a'), pr(901, 'factory/43-b')],
      comments: { 901: [cmd(7)] },
      issues: { 42: [lane], 43: [lane] },
      failList: 900,
    });
    const res = await run(env);
    expect(res).toMatchObject([
      { pr: 900, outcome: 'error', detail: 'list boom' },
      { pr: 901, outcome: 'queued' },
    ]);
  });

  it('acts once on the newest of several trusted comments', async () => {
    const env = basic([cmd(5), cmd(6)]);
    expect(await run(env)).toMatchObject([{ commentId: 6, outcome: 'queued' }]);
    expect(env.posted).toHaveLength(1);
    expect(await run(env)).toEqual([]);
  });
});

describe('file store and claimIterateCommand', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());
  const rec = (commentId: number, extra: Partial<IterateCommandRecord> = {}): IterateCommandRecord => ({
    commentId,
    pr: 900,
    issue: 42,
    actor: 'alice',
    seenAt: '2026-01-01T00:00:00.000Z',
    outcome: 'queued',
    ...extra,
  });

  it('a corrupt store reads as empty', () => {
    const file = join(tempDirs.makeSync('iterate-'), 's.json');
    writeFileSync(file, '{nope');
    const store = createFileIterateStore(file);
    expect(store.list()).toEqual([]);
    expect(store.has(1)).toBe(false);
  });

  it('persists records and markStarted ignores unknown ids', () => {
    const file = join(tempDirs.makeSync('iterate-'), 'nested', 's.json');
    const store = createFileIterateStore(file);
    store.record(rec(1));
    store.markStarted(99, 'x');
    store.markStarted(1, 'then');
    expect(createFileIterateStore(file).list()).toMatchObject([{ commentId: 1, startedAt: 'then' }]);
  });

  it('claims the newest pending record, coalesces older ones, and ignores rejected and ignored records', () => {
    const store = createFileIterateStore(join(tempDirs.makeSync('iterate-'), 's.json'));
    store.record(rec(1, { seenAt: '2026-01-01T00:00:00.000Z' }));
    store.record(rec(2, { seenAt: '2026-01-02T00:00:00.000Z' }));
    store.record(rec(3, { seenAt: '2026-01-03T00:00:00.000Z', outcome: 'rejected' }));
    store.record(rec(4, { seenAt: '2026-01-04T00:00:00.000Z', outcome: 'ignored' }));
    store.record(rec(5, { issue: 7 }));
    const claimed = claimIterateCommand(store, 42, () => new Date('2026-02-01T00:00:00Z'));
    expect(claimed).toMatchObject({ commentId: 2, startedAt: '2026-02-01T00:00:00.000Z' });
    expect(
      store
        .list()
        .filter((r) => r.startedAt)
        .map((r) => r.commentId),
    ).toEqual([1, 2]);
    expect(claimIterateCommand(store, 42)).toBeUndefined();
    expect(claimIterateCommand(store, 7)).toMatchObject({ commentId: 5 });
  });

  it('breaks a seenAt tie on the higher commentId', () => {
    const store = createFileIterateStore(join(tempDirs.makeSync('iterate-'), 's.json'));
    store.record(rec(1));
    store.record(rec(2));
    expect(claimIterateCommand(store, 42)?.commentId).toBe(2);
  });
});
