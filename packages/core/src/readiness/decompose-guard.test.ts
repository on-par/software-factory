// packages/core/src/readiness/decompose-guard.test.ts — tests for the decompose pre-flight guard (#728)

import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import {
  checkDecomposeGuard,
  DECOMPOSE_PROPOSAL_MARKER,
  DECOMPOSE_PROPOSAL_WINDOW_MS,
  findPendingProposal,
  isDecomposeProposal,
} from './decompose-guard.js';
import type { GuardComment } from './decompose-guard.js';

const NOW = new Date('2026-01-10T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function comment(over: Partial<GuardComment> & { id: number }): GuardComment {
  return { body: 'hi', createdAt: ago(HOUR), userId: 2, userType: 'User', ...over };
}
const proposal = (id: number, createdAt = ago(HOUR)): GuardComment =>
  comment({ id, body: `## Proposed epic: x\n\n${DECOMPOSE_PROPOSAL_MARKER}`, createdAt, userId: 1, userType: 'Bot' });

describe('isDecomposeProposal', () => {
  it('matches the marker and the legacy heading only', () => {
    expect(isDecomposeProposal(`body\n${DECOMPOSE_PROPOSAL_MARKER}`)).toBe(true);
    expect(isDecomposeProposal('  ## Proposed epic: Foo')).toBe(true);
    expect(isDecomposeProposal('just a comment')).toBe(false);
  });
});

describe('findPendingProposal', () => {
  const find = (comments: GuardComment[]) => findPendingProposal(comments, 1, NOW, DECOMPOSE_PROPOSAL_WINDOW_MS);

  it('returns the own proposal inside the window', () => {
    expect(find([proposal(10)])?.id).toBe(10);
  });

  it('still returns it after a Bot reply or another own comment', () => {
    const bot = comment({ id: 11, userId: 3, userType: 'Bot' });
    const own = comment({ id: 12, userId: 1 });
    expect(find([proposal(10), bot, own])?.id).toBe(10);
  });

  it('ignores a proposal superseded by a human reply or older than the window (#728)', () => {
    expect(find([proposal(10), comment({ id: 11 })])).toBeUndefined();
    expect(find([proposal(10, ago(DECOMPOSE_PROPOSAL_WINDOW_MS + 1))])).toBeUndefined();
    expect(find([proposal(10, 'not-a-date')])).toBeUndefined();
  });

  it('ignores a proposal heading by another user and lets the latest own proposal decide', () => {
    expect(find([comment({ id: 5, body: '## Proposed epic: y', userId: 9 })])).toBeUndefined();
    expect(find([proposal(10), comment({ id: 11 }), proposal(12)])?.id).toBe(12);
  });

  it('handles a null user and an empty body', () => {
    expect(find([proposal(10), comment({ id: 11, userId: undefined, userType: undefined, body: '' })])?.id).toBe(10);
  });
});

function makeOctokit(over: { get?: () => unknown; me?: () => unknown; list?: (args: { page: number }) => unknown }) {
  const get = vi.fn(over.get ?? (() => ({ data: { state: 'open' } })));
  const getAuthenticated = vi.fn(over.me ?? (() => ({ data: { id: 1 } })));
  const listComments = vi.fn(over.list ?? (() => ({ data: [] })));
  const octokit = { rest: { issues: { get, listComments }, users: { getAuthenticated } } } as any;
  return { octokit, get, getAuthenticated, listComments };
}
const wire = (c: GuardComment) => ({
  id: c.id,
  body: c.body,
  created_at: c.createdAt,
  user: { id: c.userId, type: c.userType },
});
const run = (octokit: Octokit) => checkDecomposeGuard({ octokit, repo: 'o/r', issue: 7, now: NOW });

describe('checkDecomposeGuard', () => {
  it('returns issue-closed, proposal-pending and proceed for the matching GitHub state (#728)', async () => {
    const closed = makeOctokit({ get: () => ({ data: { state: 'closed' } }) });
    const verdict = await run(closed.octokit);
    expect(verdict).toMatchObject({ kind: 'issue-closed' });
    expect(verdict.kind === 'issue-closed' && verdict.reason).toMatch(/already closed/);
    expect(closed.listComments).not.toHaveBeenCalled();

    const pending = makeOctokit({ list: () => ({ data: [wire(proposal(10))] }) });
    expect(await run(pending.octokit)).toMatchObject({ kind: 'proposal-pending', commentId: 10 });

    expect(await run(makeOctokit({}).octokit)).toEqual({ kind: 'proceed' });
    expect(await run(makeOctokit({ get: () => ({ data: {} }) }).octokit)).toEqual({ kind: 'proceed' });
  });

  it('paginates until a short page', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => wire(comment({ id: i + 1, userId: 1, body: 'x' })));
    const mock = makeOctokit({
      list: ({ page }) => ({ data: page === 1 ? filler : [wire(proposal(500))] }),
    });
    expect(await run(mock.octokit)).toMatchObject({ kind: 'proposal-pending', commentId: 500 });
    expect(mock.listComments).toHaveBeenCalledTimes(2);
  });

  it('fails open when a GitHub read throws or a page is not an array', async () => {
    for (const mock of [
      makeOctokit({ get: () => Promise.reject(new Error('boom')) }),
      makeOctokit({ me: () => Promise.reject(new Error('app token')) }),
      makeOctokit({ list: () => Promise.reject(new Error('403')) }),
      makeOctokit({ list: () => ({ data: 'nope' }) }),
    ]) {
      const verdict = await run(mock.octokit);
      expect(verdict.kind).toBe('proceed');
      expect(verdict.kind === 'proceed' && verdict.warning).toBeTruthy();
    }
  });
});
