// packages/core/src/queue/orphan-drafts.test.ts — the hourly sweep closes stale orphan factory drafts and requeues their issues (#3552).

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { EventKind } from '../events/kinds.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import {
  IN_PROGRESS_LABEL,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
} from './github-queue.js';
import { renderOrphanDraftComment, selectStaleFactoryDrafts, sweepOrphanDrafts } from './orphan-drafts.js';

function createStore(
  issues: Array<{ number: number; labels: string[] }>,
  fail: { add?: (issue: number, labels: string[]) => boolean; remove?: boolean } = {},
  writes: string[] = [],
) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      return [...state]
        .filter(([, set]) => labels.every((l) => set.has(l)))
        .map(([number, set]) => ({ number, labels: [...set] }));
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      writes.push(`add #${issue_number}`);
      if (fail.add?.(issue_number, labels)) throw new Error(`boom on #${issue_number}`);
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      writes.push(`remove #${issue_number}`);
      if (fail.remove) throw new Error('remove boom');
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return { client, state };
}

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
const L = laneLabel('x');

interface Pr {
  number: number;
  branch: string;
  draft?: boolean;
  createdAt?: string;
}

function setup(
  prs: Pr[],
  issues: Array<{ number: number; labels: string[]; state?: string }>,
  opts: { closeFails?: boolean } = {},
) {
  const writes: string[] = [];
  const store = createStore(issues, {}, writes);
  const octokit = {
    rest: {
      pulls: {
        list: vi.fn(async () => ({
          data: prs.map((p) => ({
            number: p.number,
            head: { ref: p.branch },
            draft: p.draft ?? true,
            created_at: p.createdAt ?? ago(48),
          })),
        })),
        update: vi.fn(async () => {
          if (opts.closeFails) throw new Error('close boom');
          return {};
        }),
      },
      issues: {
        get: vi.fn(async ({ issue_number }: { issue_number: number }) => {
          const meta = issues.find((i) => i.number === issue_number);
          return {
            data: {
              state: meta?.state ?? 'open',
              labels: [...(store.state.get(issue_number) ?? [])].map((name) => ({ name })),
            },
          };
        }),
        createComment: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
    },
  };
  const events: Array<[EventKind, string | number, string]> = [];
  return { octokit, store, writes, events };
}

const tmp = createTempDirs();
let dir: string;
beforeEach(async () => {
  dir = await tmp.make('orphan-drafts-');
});
afterEach(async () => {
  await tmp.cleanup();
});

async function run(s: ReturnType<typeof setup>, extra: { now?: number; cap?: number } = {}) {
  return sweepOrphanDrafts(
    {
      owner: 'o',
      repo: 'r',
      stateFile: join(dir, 'state', 'sweep.json'),
      prefix: 'factory',
      now: () => extra.now ?? NOW,
      ...(extra.cap ? { cap: extra.cap } : {}),
    },
    {
      octokit: s.octokit as never,
      client: s.store.client,
      log: (type, scope, msg) => s.events.push([type, scope, msg]),
    },
  );
}

const branch = (n: number) => `factory/${n}-work`;
const claimless = (n: number, extra: string[] = []) => ({ number: n, labels: [L, ...extra] });

describe('selectStaleFactoryDrafts', () => {
  it('keeps old factory drafts, oldest first, and ignores unparsable dates', () => {
    const picked = selectStaleFactoryDrafts(
      [
        { number: 2, branch: branch(2), draft: true, createdAt: ago(30) },
        { number: 1, branch: branch(1), draft: true, createdAt: ago(50) },
        { number: 3, branch: branch(3), draft: true, createdAt: 'nope' },
        { number: 4, branch: branch(4), draft: true, createdAt: ago(23) },
      ],
      { prefix: 'factory', now: NOW },
    );
    expect(picked.map((d) => [d.pr, d.issue, d.ageHours])).toEqual([
      [1, 1, 50],
      [2, 2, 30],
    ]);
  });
});

describe('sweepOrphanDrafts', () => {
  it('closes a stale orphan draft with one comment and keeps its branch', async () => {
    const s = setup([{ number: 101, branch: branch(7) }], [claimless(7)]);
    const report = await run(s);
    expect(s.octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(s.octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 101, state: 'closed' }),
    );
    expect(s.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(s.octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 101,
        body: expect.stringContaining('<!-- factory:orphan-draft-sweep -->'),
      }),
    );
    expect(s.octokit.rest.git.deleteRef).not.toHaveBeenCalled();
    expect(report.closed).toEqual([{ pr: 101, issue: 7, lane: 'x', order: 1 }]);
    expect(s.events.map((e) => e[0])).toEqual(['orphan_draft_closed']);
  });

  it('requeues the issue at the front of its lane and removes factory:parked', async () => {
    const s = setup(
      [{ number: 101, branch: branch(7) }],
      [
        { number: 7, labels: [PARKED_LABEL, L, queueOrderLabel(7)] },
        { number: 1, labels: [QUEUED_LABEL, L, queueOrderLabel(1)] },
        { number: 2, labels: [QUEUED_LABEL, L, queueOrderLabel(2)] },
      ],
    );
    await run(s);
    const labels = s.store.state.get(7) ?? new Set<string>();
    expect([...labels].sort()).toEqual([QUEUED_LABEL, L, queueOrderLabel(1)].sort());
    expect([...(s.store.state.get(1) ?? [])]).toContain(queueOrderLabel(2));
    expect([...(s.store.state.get(2) ?? [])]).toContain(queueOrderLabel(3));
  });

  it('leaves claimed and recent drafts unchanged', async () => {
    const s = setup(
      [
        { number: 101, branch: branch(1) },
        { number: 102, branch: branch(2) },
        { number: 103, branch: branch(3), createdAt: ago(23) },
      ],
      [claimless(1, [IN_PROGRESS_LABEL]), claimless(2, ['factory:claimed-by:abc']), claimless(3)],
    );
    const report = await run(s);
    expect(s.octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(s.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(s.writes).toEqual([]);
    expect(report.skipped.map((k) => k.reason)).toEqual(['claimed', 'claimed']);
  });

  it('never touches a draft outside the factory prefix', async () => {
    const s = setup(
      [
        { number: 101, branch: 'other/123-x' },
        { number: 102, branch: branch(5), draft: false },
      ],
      [claimless(5), claimless(123)],
    );
    await run(s);
    expect(s.octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(s.octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(s.writes).toEqual([]);
  });

  it('closes at most 10 and reports the rest in one orphan_draft_sweep_capped event', async () => {
    const nums = Array.from({ length: 13 }, (_, i) => i + 1);
    const s = setup(
      nums.map((n) => ({ number: 100 + n, branch: branch(n) })),
      nums.map((n) => claimless(n)),
    );
    const report = await run(s);
    expect(report.closed).toHaveLength(10);
    expect(report.deferred).toEqual([111, 112, 113]);
    const capped = s.events.filter((e) => e[0] === 'orphan_draft_sweep_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]?.[2]).toContain('#111, #112, #113');
    expect(s.octokit.rest.pulls.update).toHaveBeenCalledTimes(10);
  });

  it('a second sweep within the hour makes no GitHub calls', async () => {
    const s = setup([{ number: 101, branch: branch(7) }], [claimless(7)]);
    await run(s);
    const calls = () => Object.values(s.octokit.rest.pulls).length;
    expect(calls()).toBe(2);
    s.octokit.rest.pulls.list.mockClear();
    s.octokit.rest.issues.get.mockClear();
    const writesBefore = s.writes.length;
    const second = await run(s, { now: NOW + 59 * 60_000 });
    expect(second.throttled).toBe(true);
    expect(s.octokit.rest.pulls.list).not.toHaveBeenCalled();
    expect(s.octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(s.writes.length).toBe(writesBefore);
    const third = await run(s, { now: NOW + 61 * 60_000 });
    expect(third.throttled).toBe(false);
    expect(s.octokit.rest.pulls.list).toHaveBeenCalledTimes(1);
  });

  it('skips closed issues and issues with zero or several lane labels', async () => {
    const s = setup(
      [
        { number: 101, branch: branch(1) },
        { number: 102, branch: branch(2) },
        { number: 103, branch: branch(3) },
      ],
      [
        { ...claimless(1), state: 'closed' },
        { number: 2, labels: [] },
        { number: 3, labels: [L, laneLabel('y')] },
      ],
    );
    const report = await run(s);
    expect(report.skipped.map((k) => k.reason)).toEqual(['issue-closed', 'no-lane', 'multiple-lanes']);
    expect(s.octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it('requeues an issue once when two stale drafts share it and closes both', async () => {
    const s = setup(
      [
        { number: 101, branch: branch(7), createdAt: ago(60) },
        { number: 102, branch: 'factory/7-retry', createdAt: ago(50) },
      ],
      [claimless(7)],
    );
    const report = await run(s);
    expect(report.closed.map((c) => c.pr)).toEqual([101, 102]);
    expect([...(s.store.state.get(7) ?? [])].filter((l) => l.startsWith('factory:order:'))).toEqual([
      queueOrderLabel(1),
    ]);
    expect(s.octokit.rest.pulls.update).toHaveBeenCalledTimes(2);
  });

  it('posts no comment when the close fails', async () => {
    const s = setup([{ number: 101, branch: branch(7) }], [claimless(7)], { closeFails: true });
    const report = await run(s);
    expect(report.skipped).toEqual([{ pr: 101, issue: 7, reason: 'close-failed' }]);
    expect(s.octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe('renderOrphanDraftComment', () => {
  it('names the issue, lane, branch and age', () => {
    const body = renderOrphanDraftComment({ issue: 7, branch: 'factory/7-x', lane: 'x', ageHours: 30 });
    expect(body).toContain('30h');
    expect(body).toContain('#7');
    expect(body).toContain('factory/7-x');
    expect(body).toContain('`x`');
  });
});
