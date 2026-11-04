// packages/core/src/run/pr-run-state.test.ts — PR-persisted run state: encode/decode, trust, reconcile, save/load (#3909)
import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import type { RunStatus } from '../types/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  MAX_ENCODED_CHARS,
  decodePrRunState,
  encodePrRunState,
  loadPrRunState,
  prRunStatusFor,
  reconcilePrRunState,
  savePrRunState,
  selectTrustedPrRunState,
  type PrRunState,
} from './pr-run-state.js';

const key = workKeyFromIssue(42);
const SELF = 7;

function state(over: Partial<PrRunState> = {}): PrRunState {
  return {
    version: 1,
    key,
    prNumber: 9,
    status: 'awaiting-review',
    spec: { sha256: 'a'.repeat(64), summary: 'Ship the thing.' },
    checkRework: { used: 1, cap: 3 },
    reviewRework: { used: 2, cap: 3 },
    handledReviewIds: [11, 12],
    handledCommentIds: [5],
    rounds: [{ kind: 'check', headSha: 'abc1234', at: '2026-11-04T00:00:00.000Z' }],
    updatedAt: '2026-11-04T01:00:00.000Z',
    ...over,
  };
}

const dataOf = (body: string): { b64: string; digest: string; json: string } => {
  const m = /factory:run-state-data (\S*) sha256:([0-9a-f]{64})/.exec(body);
  if (!m) throw new Error('no data line');
  return { b64: m[1], digest: m[2], json: Buffer.from(m[1], 'base64').toString('utf8') };
};

describe('pr run state', () => {
  it('encode then decode round-trips every resumable field', () => {
    const decoded = decodePrRunState(encodePrRunState(state()), key);
    expect(decoded).toEqual({ ok: true, state: state() });
  });

  it('ignores a state block posted by another user and reports untrusted-author', () => {
    const body = encodePrRunState(state());
    const out = selectTrustedPrRunState([{ id: 1, authorId: 99, body }], SELF, key);
    expect(out).toEqual({ status: 'none', ignored: [{ commentId: 1, reason: 'untrusted-author' }] });
  });

  it('ignores a block whose payload was edited and reports digest-mismatch', () => {
    const body = encodePrRunState(state());
    const { b64, json } = dataOf(body);
    const edited = JSON.stringify({ ...JSON.parse(json), reviewRework: { used: 0, cap: 3 } });
    const forged = body.replace(b64, Buffer.from(edited).toString('base64'));
    expect(selectTrustedPrRunState([{ id: 1, authorId: SELF, body: forged }], SELF, key)).toEqual({
      status: 'none',
      ignored: [{ commentId: 1, reason: 'digest-mismatch' }],
    });
  });

  it('ignores a block for another key and reports key-mismatch', () => {
    const body = encodePrRunState(state({ key: workKeyFromIssue(43) }));
    expect(decodePrRunState(body, key)).toEqual({ ok: false, reason: 'key-mismatch' });
    expect(selectTrustedPrRunState([{ id: 1, authorId: SELF, body }], SELF, key).ignored[0]?.reason).toBe(
      'key-mismatch',
    );
  });

  it('reports malformed for bad base64, bad JSON and unknown keys', () => {
    const body = encodePrRunState(state());
    const { b64, digest, json } = dataOf(body);
    const withData = (data: string, d = digest): string =>
      body.replace(/<!-- factory:run-state-data .*-->/, `<!-- factory:run-state-data ${data} sha256:${d} -->`);
    const b64Of = (t: string): string => Buffer.from(t).toString('base64');
    expect(decodePrRunState(body.split('\n').slice(0, 2).join('\n'), key)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodePrRunState(withData('!!!'), key)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodePrRunState(withData(b64Of('{nope')), key)).toEqual({ ok: false, reason: 'malformed' });
    const extra = JSON.stringify({ ...JSON.parse(json), transcript: 'x' });
    expect(decodePrRunState(withData(b64Of(extra)), key)).toEqual({ ok: false, reason: 'malformed' });
    expect(b64.length).toBeGreaterThan(0);
  });

  it('round-trips draftReason, still parses a comment without it and rejects an unknown value', () => {
    const body = encodePrRunState(state({ draftReason: 'ci-pending' }));
    const out = selectTrustedPrRunState([{ id: 1, authorId: SELF, body }], SELF, key);
    expect(out).toMatchObject({ status: 'found', state: { draftReason: 'ci-pending' } });
    const plain = decodePrRunState(encodePrRunState(state()), key);
    expect(plain).toMatchObject({ ok: true });
    expect(plain && plain.ok && 'draftReason' in plain.state).toBe(false);
    const { json, b64 } = dataOf(body);
    const bad = JSON.stringify({ ...JSON.parse(json), draftReason: 'bogus' });
    const forged = body.replace(b64, Buffer.from(bad).toString('base64'));
    expect(decodePrRunState(forged, key)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reconcile takes draftReason from the later side', () => {
    const local = state({ updatedAt: '2026-11-04T01:00:00.000Z' });
    const remote = state({ draftReason: 'ci-pending', updatedAt: '2026-11-04T02:00:00.000Z' });
    expect(reconcilePrRunState(local, remote)?.draftReason).toBe('ci-pending');
    expect(reconcilePrRunState(remote, local)?.draftReason).toBe('ci-pending');
  });

  it('returns null for a body with no marker', () => {
    expect(decodePrRunState('hello', key)).toBeNull();
  });

  it('ignores all state when the authenticated identity is unavailable', () => {
    const body = encodePrRunState(state());
    const out = selectTrustedPrRunState([{ id: 1, authorId: SELF, body }], undefined, key);
    expect(out).toEqual({ status: 'none', ignored: [{ commentId: 1, reason: 'identity-unavailable' }] });
  });

  it('the lowest-id trusted block wins', () => {
    const first = encodePrRunState(state({ prNumber: 1 }));
    const second = encodePrRunState(state({ prNumber: 2 }));
    const out = selectTrustedPrRunState(
      [
        { id: 20, authorId: SELF, body: second },
        { id: 10, authorId: SELF, body: first },
        { id: 5, authorId: SELF, body: 'unrelated' },
      ],
      SELF,
      key,
    );
    expect(out).toMatchObject({ status: 'found', commentId: 10, state: { prNumber: 1 } });
  });

  it('reconcile takes the remote state when local is missing', () => {
    expect(reconcilePrRunState(null, state())).toEqual(state());
    expect(reconcilePrRunState(state(), null)).toEqual(state());
    expect(reconcilePrRunState(null, null)).toBeNull();
  });

  it('reconcile keeps the max counters and the union of handled ids', () => {
    const local = state({
      checkRework: { used: 0, cap: 5 },
      reviewRework: { used: 1, cap: 5 },
      handledReviewIds: [12, 13],
      status: 'building',
      updatedAt: '2026-11-04T02:00:00.000Z',
      rounds: [{ kind: 'check', headSha: 'abc1234', at: '2026-11-04T00:00:00.000Z' }],
    });
    const merged = reconcilePrRunState(local, state());
    expect(merged).toMatchObject({
      checkRework: { used: 1, cap: 5 },
      reviewRework: { used: 2, cap: 5 },
      handledReviewIds: [11, 12, 13],
      status: 'building',
      updatedAt: '2026-11-04T02:00:00.000Z',
    });
    expect(merged?.rounds).toHaveLength(1);
  });

  it('encode redacts tokens in the spec summary and drops unknown fields', () => {
    const dirty = Object.assign(
      state({ spec: { sha256: 'a'.repeat(64), summary: `use ghp_${'b'.repeat(30)} here` } }),
      { transcript: 'model said hello' },
    );
    const { json } = dataOf(encodePrRunState(dirty));
    expect(json).not.toContain('ghp_');
    expect(json).not.toContain('transcript');
    expect(json).not.toContain('model said hello');
  });

  it('encode stays under the comment size cap', () => {
    const big = state({
      handledReviewIds: Array.from({ length: 5000 }, (_, i) => 1_000_000_000 + i),
      rounds: Array.from({ length: 500 }, (_, i) => ({
        kind: 'review' as const,
        id: 1_000_000_000 + i,
        headSha: 'a'.repeat(40),
        at: `2026-11-04T00:00:${String(i).padStart(3, '0')}Z`,
      })),
      spec: { sha256: 'a'.repeat(64), summary: 'x'.repeat(5000) },
    });
    const body = encodePrRunState(big);
    expect(body.length).toBeLessThanOrEqual(MAX_ENCODED_CHARS);
    const decoded = decodePrRunState(body, key);
    expect(decoded?.ok).toBe(true);
    if (decoded?.ok) expect(decoded.state.spec.summary).toHaveLength(1000);
  });

  it('prRunStatusFor maps every RunStatus', () => {
    const expected: Record<RunStatus, ReturnType<typeof prRunStatusFor>> = {
      pending: 'building',
      planning: 'building',
      building: 'building',
      checking: 'building',
      reworking: 'building',
      shipping: 'awaiting-ci',
      ready: 'awaiting-review',
      'awaiting-review': 'awaiting-review',
      merged: 'awaiting-review',
      parked: 'parked',
      escalated: 'parked',
      failed: 'parked',
    };
    for (const [status, want] of Object.entries(expected)) {
      expect(prRunStatusFor(status as RunStatus)).toBe(want);
    }
    expect(prRunStatusFor('ready', true)).toBe('awaiting-ci');
  });
});

type Stored = { id: number; user: { id: number }; body: string };

function fakeOctokit(opts: { selfId?: number | 'fail'; comments?: Stored[] } = {}): {
  octokit: Octokit;
  comments: Stored[];
} {
  const comments = opts.comments ?? [];
  let next = 100;
  const rest = {
    users: {
      getAuthenticated: async () => {
        if (opts.selfId === 'fail') throw new Error('no identity');
        return { data: { id: opts.selfId ?? SELF } };
      },
    },
    issues: {
      listComments: async ({ page }: { page: number }) => ({ data: page === 1 ? comments : [] }),
      createComment: async ({ body }: { body: string }) => {
        const c = { id: next++, user: { id: opts.selfId === 'fail' ? SELF : (opts.selfId ?? SELF) }, body };
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

describe('savePrRunState / loadPrRunState', () => {
  it("savePrRunState upserts the factory's own PR comment and loadPrRunState reads it back", async () => {
    const { octokit, comments } = fakeOctokit({ comments: [{ id: 1, user: { id: 99 }, body: 'hi' }] });
    const first = await savePrRunState({ octokit, repo: 'o/r', prNumber: 9, state: state() });
    expect(first.created).toBe(true);
    const second = await savePrRunState({
      octokit,
      repo: 'o/r',
      prNumber: 9,
      state: state({ reviewRework: { used: 3, cap: 3 } }),
    });
    expect(second).toEqual({ commentId: first.commentId, created: false });
    expect(comments).toHaveLength(2);

    const loaded = await loadPrRunState({ octokit, repo: 'o/r', prNumber: 9, key });
    expect(loaded).toMatchObject({ status: 'found', state: { reviewRework: { used: 3, cap: 3 } } });
  });

  it('loadPrRunState fails closed when the identity lookup throws', async () => {
    const body = encodePrRunState(state());
    const { octokit } = fakeOctokit({ selfId: 'fail', comments: [{ id: 3, user: { id: SELF }, body }] });
    const loaded = await loadPrRunState({ octokit, repo: 'o/r', prNumber: 9, key });
    expect(loaded).toEqual({ status: 'none', ignored: [{ commentId: 3, reason: 'identity-unavailable' }] });
  });
});
