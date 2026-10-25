import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { laneLabel, PARKED_LABEL, QUEUED_LABEL, type QueueGitHubClient } from '../queue/github-queue.js';
import { runUnpark } from '../queue/unpark.js';
import { renderParkComment } from '../run/park-comment.js';
import type { BlockedByItem } from './dependencies.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  type BlockedParkStore,
  type BlockerEvidence,
  createOctokitBlockedParkStore,
  MAX_AUTO_UNPARKS,
  pollBlockedParks,
} from './poller.js';
import { fakeIssueComments } from '../queue/fake-issue-comments.js';

function fakeClient(labels: Map<number, string[]>) {
  const addLabels = vi.fn(async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
    const have = labels.get(issue_number) ?? [];
    labels.set(issue_number, [...have, ...add.filter((l) => !have.includes(l))]);
  });
  const removeLabel = vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
    labels.set(
      issue_number,
      (labels.get(issue_number) ?? []).filter((l) => l !== name),
    );
  });
  const client: QueueGitHubClient = {
    listOpenIssuesWithLabels: async ({ labels: want }) =>
      [...labels.entries()]
        .filter(([, have]) => want.every((w) => have.includes(w)))
        .map(([number, have]) => ({ number, labels: [...have] })),
    getIssueLabels: async ({ issue_number }) => [...(labels.get(issue_number) ?? [])],
    addLabels,
    removeLabel,
    ...fakeIssueComments(),
    ensureLabel: async () => false,
  };
  return { client, addLabels, removeLabel };
}

const base = { owner: 'o', repo: 'r' };
const parked = (...extra: string[]) => [PARKED_LABEL, laneLabel('build'), ...extra];

function comment(issue: number, over: { reason?: 'blocked' | 'fail'; autoUnparks?: number } = {}) {
  return renderParkComment({
    issue: workKeyFromIssue(issue),
    reason: over.reason ?? 'blocked',
    message: 'blocked',
    runId: 'r1',
    branch: `issue-${issue}`,
    autoUnparks: over.autoUnparks,
  });
}

const blocker = (number: number, over: Partial<BlockedByItem> = {}): BlockedByItem => ({
  number,
  state: 'closed',
  stateReason: 'completed',
  repository: 'o/r',
  ...over,
});

function fakeStore(
  comments: Map<number, string>,
  blockedBy: Map<number, BlockedByItem[]>,
  evidence: Map<number, BlockerEvidence> = new Map(),
) {
  const bodies = new Map<number, string>(); // commentId (= issue) -> latest body
  for (const [k, v] of comments) bodies.set(k, v);
  const updateComment = vi.fn(async (id: number, body: string) => {
    bodies.set(id, body);
  });
  const store: BlockedParkStore = {
    readParkComment: async (issue) => {
      const body = bodies.get(issue);
      return body === undefined ? undefined : { id: issue, body };
    },
    updateComment,
    listBlockedBy: async (issue) => blockedBy.get(issue) ?? [],
    blockerEvidence: async (n) => evidence.get(n) ?? { factoryFiled: false, mergedClosingPr: false },
  };
  return { store, bodies, updateComment };
}

describe('pollBlockedParks', () => {
  it('unparks a blocked parent whose factory-filed blocker closed completed with a merged PR', async () => {
    const labels = new Map([[5, parked()]]);
    const { client, addLabels, removeLabel } = fakeClient(labels);
    const { store, bodies } = fakeStore(
      new Map([[5, comment(5)]]),
      new Map([[5, [blocker(9)]]]),
      new Map([[9, { factoryFiled: true, mergedClosingPr: true }]]),
    );
    const logEvent = vi.fn();
    const results = await pollBlockedParks({ client, ...base, store, logEvent });
    expect(results).toEqual([{ issue: 5, outcome: 'unparked', lane: 'build', order: 1 }]);
    const have = labels.get(5)!;
    expect(have).toContain(QUEUED_LABEL);
    expect(have.filter((l) => l.startsWith('factory:order:'))).toHaveLength(1);
    expect(have).not.toContain(PARKED_LABEL);
    expect(removeLabel.mock.calls.at(-1)![0].name).toBe(PARKED_LABEL);
    expect(addLabels).toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('issue_unparked', 5, expect.stringContaining('blockers #9 resolved'));
    expect(bodies.get(5)).toContain('status: resumed');
    expect(bodies.get(5)).toContain('auto-unparks: 1');
  });

  it('works with the default no-op logEvent', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store } = fakeStore(new Map([[5, comment(5)]]), new Map([[5, [blocker(9, { repository: 'x/y' })]]]));
    expect((await pollBlockedParks({ client, ...base, store }))[0].outcome).toBe('unparked');
  });

  it('resolves a non-factory same-repo blocker without a PR', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store } = fakeStore(
      new Map([[5, comment(5)]]),
      new Map([[5, [blocker(9)]]]),
      new Map([[9, { factoryFiled: false, mergedClosingPr: false }]]),
    );
    expect((await pollBlockedParks({ client, ...base, store }))[0].outcome).toBe('unparked');
  });

  it.each([
    ['not_planned', 'not_planned'],
    ['duplicate', 'duplicate'],
    [null, 'without a reason'],
    ['weird', 'weird'],
  ])('holds the parent and does not enqueue when a blocker closed %s', async (reason, text) => {
    const labels = new Map([[5, parked()]]);
    const { client, addLabels } = fakeClient(labels);
    const { store, bodies } = fakeStore(
      new Map([[5, comment(5)]]),
      new Map([[5, [blocker(8, { state: 'open', stateReason: null }), blocker(9, { stateReason: reason })]]]),
    );
    const [r] = await pollBlockedParks({ client, ...base, store });
    expect(r.outcome).toBe('held');
    expect(r.detail).toBe(`blocker #9 closed ${text}`);
    expect(labels.get(5)).toContain(PARKED_LABEL);
    expect(addLabels).not.toHaveBeenCalled();
    expect(bodies.get(5)).toContain('reason: held');
    expect(bodies.get(5)).toContain(`status: held: blocker #9 closed ${text}`);
  });

  it('keeps the first abandoned blocker as the detail', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store } = fakeStore(
      new Map([[5, comment(5)]]),
      new Map([[5, [blocker(8, { stateReason: 'duplicate' }), blocker(9, { stateReason: 'not_planned' })]]]),
    );
    expect((await pollBlockedParks({ client, ...base, store }))[0].detail).toBe('blocker #8 closed duplicate');
  });

  it('parks held instead of enqueueing after two auto-unparks', async () => {
    const { client, addLabels } = fakeClient(new Map([[5, parked()]]));
    const { store, bodies } = fakeStore(
      new Map([[5, comment(5, { autoUnparks: MAX_AUTO_UNPARKS })]]),
      new Map([[5, [blocker(9)]]]),
    );
    const [r] = await pollBlockedParks({ client, ...base, store });
    expect(r.outcome).toBe('capped');
    expect(addLabels).not.toHaveBeenCalled();
    expect(bodies.get(5)).toContain('reason: held');
    expect(bodies.get(5)).toContain('status: held: auto-unpark cap (2) reached');
  });

  it('a manual unpark racing the poller yields exactly one enqueue and one order label', async () => {
    const labels = new Map([[5, parked()]]);
    const { client, addLabels } = fakeClient(labels);
    const { store, updateComment } = fakeStore(new Map([[5, comment(5)]]), new Map([[5, [blocker(9)]]]));
    const read = store.readParkComment;
    let first = true;
    store.readParkComment = async (n) => {
      if (first) {
        first = false;
        await runUnpark({ client, ...base, issue: n });
      }
      return read(n);
    };
    const [r] = await pollBlockedParks({ client, ...base, store });
    expect(r.outcome).toBe('raced');
    expect(addLabels.mock.calls.filter(([a]) => a.labels.includes(QUEUED_LABEL))).toHaveLength(1);
    expect(labels.get(5)!.filter((l) => l.startsWith('factory:order:'))).toHaveLength(1);
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('waits on an open blocker and on a factory-filed blocker with no merged PR, with no writes', async () => {
    const { client, addLabels } = fakeClient(
      new Map([
        [5, parked()],
        [6, parked()],
      ]),
    );
    const { store, updateComment } = fakeStore(
      new Map([
        [5, comment(5)],
        [6, comment(6)],
      ]),
      new Map([
        [5, [blocker(9, { state: 'open', stateReason: null })]],
        [6, [blocker(10)]],
      ]),
      new Map([[10, { factoryFiled: true, mergedClosingPr: false }]]),
    );
    const results = await pollBlockedParks({ client, ...base, store });
    expect(results.map((r) => r.outcome)).toEqual(['waiting', 'waiting']);
    expect(updateComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('skips with the cause: no comment, other reason, no blockers', async () => {
    const { client } = fakeClient(
      new Map([
        [1, parked()],
        [2, parked()],
        [3, parked()],
        [4, parked()],
      ]),
    );
    const { store } = fakeStore(
      new Map([
        [2, comment(2, { reason: 'fail' })],
        [3, comment(3)],
        [4, 'no state block\n<!-- factory-issue-state v1 issue:4 -->'],
      ]),
      new Map(),
    );
    const results = await pollBlockedParks({ client, ...base, store });
    expect(results).toEqual([
      { issue: 1, outcome: 'skipped', detail: 'no park comment' },
      { issue: 2, outcome: 'skipped', detail: 'reason fail' },
      { issue: 3, outcome: 'skipped', detail: 'no blockers' },
      { issue: 4, outcome: 'skipped', detail: 'no park comment' },
    ]);
  });

  it('writes nothing when the patch cannot be applied', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store, updateComment } = fakeStore(
      new Map([[5, comment(5)]]),
      new Map([[5, [blocker(9, { stateReason: 'not_planned' })]]]),
    );
    const read = store.readParkComment;
    store.readParkComment = async (n) => {
      const c = (await read(n))!;
      // Valid for readParkState, but patchParkComment finds no fence on the second parse.
      return {
        id: c.id,
        get body() {
          return reads++ < 2 ? comment(5) : 'no block';
        },
      } as { id: number; body: string };
    };
    let reads = 0;
    const [r] = await pollBlockedParks({ client, ...base, store });
    expect(r.outcome).toBe('held');
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('isolates errors per parent and reports lane-required', async () => {
    const { client } = fakeClient(
      new Map([
        [5, parked()],
        [6, [PARKED_LABEL]],
        [7, parked()],
      ]),
    );
    const { store } = fakeStore(
      new Map([
        [5, comment(5)],
        [6, comment(6)],
        [7, comment(7)],
      ]),
      new Map([
        [6, [blocker(9)]],
        [7, [blocker(9)]],
      ]),
    );
    const list = store.listBlockedBy;
    store.listBlockedBy = async (n) => {
      if (n === 5) throw new Error('api down');
      return list(n);
    };
    const results = await pollBlockedParks({ client, ...base, store });
    expect(results[0]).toEqual({ issue: 5, outcome: 'error', detail: 'api down' });
    expect(results[1].outcome).toBe('error');
    expect(results[1].detail).toContain('lane');
    expect(results[2].outcome).toBe('unparked');
  });

  it('stringifies a non-Error throw', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store } = fakeStore(new Map([[5, comment(5)]]), new Map());
    store.listBlockedBy = async () => {
      throw 'plain';
    };
    expect((await pollBlockedParks({ client, ...base, store }))[0].detail).toBe('plain');
  });

  it('warns but still reports unparked when the comment write fails', async () => {
    const labels = new Map([[5, parked()]]);
    const { client } = fakeClient(labels);
    const { store } = fakeStore(new Map([[5, comment(5)]]), new Map([[5, [blocker(9)]]]));
    store.updateComment = async () => {
      throw new Error('write failed');
    };
    const logEvent = vi.fn();
    const [r] = await pollBlockedParks({ client, ...base, store, logEvent });
    expect(r).toMatchObject({ outcome: 'unparked', lane: 'build', order: 1 });
    expect(logEvent).toHaveBeenCalledWith('warn', 5, 'park comment not updated: write failed');
  });

  it('does not write a comment after unpark when the patch cannot be applied', async () => {
    const { client } = fakeClient(new Map([[5, parked()]]));
    const { store, updateComment } = fakeStore(new Map([[5, comment(5)]]), new Map([[5, [blocker(9)]]]));
    let reads = 0;
    store.readParkComment = async () =>
      ({
        id: 5,
        get body() {
          return reads++ < 2 ? comment(5) : 'no block';
        },
      }) as { id: number; body: string };
    expect((await pollBlockedParks({ client, ...base, store }))[0].outcome).toBe('unparked');
    expect(updateComment).not.toHaveBeenCalled();
  });
});

describe('createOctokitBlockedParkStore', () => {
  function fakeOctokit(opts: { body?: string | null; graphql?: unknown }) {
    const updateComment = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ data: { body: opts.body } }));
    const graphql = vi.fn(async () => opts.graphql);
    const request = vi.fn(async () => ({ data: [{ number: 3, state: 'open', repository: { full_name: 'o/r' } }] }));
    const octokit = Object.assign({} as Octokit, { rest: { issues: { get, updateComment } }, graphql, request });
    return { octokit, updateComment, get, graphql, request };
  }
  const merged = (...m: unknown[]) => ({
    repository: { issue: { closedByPullRequestsReferences: { nodes: m.map((merged) => ({ merged })) } } },
  });

  it('detects the factory-blocker marker and a merged closing PR', async () => {
    const f = fakeOctokit({ body: 'x <!-- factory-blocker v1 parent:5 hash:abc -->', graphql: merged(false, true) });
    const store = createOctokitBlockedParkStore(f.octokit, 'o/r');
    expect(await store.blockerEvidence(9)).toEqual({ factoryFiled: true, mergedClosingPr: true });
    expect(f.graphql).toHaveBeenCalledWith(expect.stringContaining('includeClosedPrs:true'), {
      owner: 'o',
      name: 'r',
      number: 9,
    });
  });

  it('reports unmerged PRs, a null body, and malformed GraphQL as not merged', async () => {
    const un = createOctokitBlockedParkStore(fakeOctokit({ body: 'plain', graphql: merged(false) }).octokit, 'o/r');
    expect(await un.blockerEvidence(9)).toEqual({ factoryFiled: false, mergedClosingPr: false });
    const nul = createOctokitBlockedParkStore(fakeOctokit({ body: null, graphql: null }).octokit, 'o/r');
    expect(await nul.blockerEvidence(9)).toEqual({ factoryFiled: false, mergedClosingPr: false });
    const bad = createOctokitBlockedParkStore(fakeOctokit({ body: '', graphql: { repository: {} } }).octokit, 'o/r');
    expect((await bad.blockerEvidence(9)).mergedClosingPr).toBe(false);
    const holes = createOctokitBlockedParkStore(
      fakeOctokit({
        body: '',
        graphql: { repository: { issue: { closedByPullRequestsReferences: { nodes: [null] } } } },
      }).octokit,
      'o/r',
    );
    expect((await holes.blockerEvidence(9)).mergedClosingPr).toBe(false);
  });

  it('updates comments and lists blocked_by through octokit', async () => {
    const f = fakeOctokit({});
    const store = createOctokitBlockedParkStore(f.octokit, 'o/r');
    await store.updateComment(11, 'new');
    expect(f.updateComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 11, body: 'new' });
    expect(await store.listBlockedBy(5)).toEqual([{ number: 3, state: 'open', stateReason: null, repository: 'o/r' }]);
  });

  it('reads the own park comment via the paginated lookup', async () => {
    const listComments = vi.fn(async () => ({ data: [{ id: 2, body: comment(5), user: { id: 1 } }] }));
    const octokit = Object.assign({} as Octokit, {
      rest: { users: { getAuthenticated: async () => ({ data: { id: 1 } }) }, issues: { listComments } },
    });
    const got = await createOctokitBlockedParkStore(octokit, 'o/r').readParkComment(5);
    expect(got?.id).toBe(2);
  });
});
