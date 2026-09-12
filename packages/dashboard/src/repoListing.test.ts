import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_REPOS_URL } from './repoAttach.js';
import { fetchRepos, parseRepoListing, type AttachedRepo } from './repoListing.js';

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const REPO_A: AttachedRepo = {
  slug: 'on-par/software-factory',
  path: '/tmp/software-factory',
  attachedAt: '2026-01-01T00:00:00.000Z',
  state: 'active',
};

const REPO_B: AttachedRepo = {
  slug: 'on-par/adr-kit',
  path: '/tmp/adr-kit',
  attachedAt: '2026-01-02T00:00:00.000Z',
  state: 'paused',
};

describe('parseRepoListing', () => {
  it('returns [] for null', () => {
    expect(parseRepoListing(null)).toEqual([]);
  });

  it('returns [] for a non-object', () => {
    expect(parseRepoListing('nope')).toEqual([]);
  });

  it('returns [] for an array payload', () => {
    expect(parseRepoListing([REPO_A])).toEqual([]);
  });

  it('returns [] when repos is not an array', () => {
    expect(parseRepoListing({ repos: 'nope' })).toEqual([]);
  });

  it('drops rows with a missing field, an unknown state, and keeps well-formed siblings, sorted by slug', () => {
    const missingField = { slug: 'a/b', path: '/tmp/b', attachedAt: '2026-01-01T00:00:00.000Z' };
    const unknownState = { ...REPO_A, slug: 'z/z', state: 'archived' };
    const result = parseRepoListing({ repos: [REPO_A, missingField, unknownState, REPO_B] });
    expect(result).toEqual([REPO_B, REPO_A]);
  });
});

describe('fetchRepos', () => {
  it('requests DEFAULT_REPOS_URL by default', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { repos: [] }));
    await fetchRepos({ fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(DEFAULT_REPOS_URL);
  });

  it('requests deps.url when given', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { repos: [] }));
    await fetchRepos({ fetch: fetchFn, url: '/custom-repos' });
    expect(fetchFn).toHaveBeenCalledWith('/custom-repos');
  });

  it('returns { ok: true, repos } for a 200 listing', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { repos: [REPO_A, REPO_B] }));
    const outcome = await fetchRepos({ fetch: fetchFn });
    expect(outcome).toEqual({ ok: true, repos: [REPO_B, REPO_A] });
  });

  it('returns { ok: false } with the status in the message for a 500', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(500, { error: 'boom' }));
    const outcome = await fetchRepos({ fetch: fetchFn });
    expect(outcome).toEqual({ ok: false, error: 'factoryd responded 500' });
  });

  it('returns { ok: false } for a body that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('not json{{{', { status: 200 }));
    const outcome = await fetchRepos({ fetch: fetchFn });
    expect(outcome.ok).toBe(false);
  });

  it('returns { ok: false } for a fetch that rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const outcome = await fetchRepos({ fetch: fetchFn });
    expect(outcome).toEqual({ ok: false, error: 'connection refused' });
  });

  it('defaults to globalThis.fetch when no fetch dep is injected', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { repos: [] }));
    vi.stubGlobal('fetch', fetchFn);
    try {
      const outcome = await fetchRepos();
      expect(outcome).toEqual({ ok: true, repos: [] });
      expect(fetchFn).toHaveBeenCalledWith(DEFAULT_REPOS_URL);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
