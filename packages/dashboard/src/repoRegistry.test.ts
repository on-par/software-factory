import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepoRegistryClient, DEFAULT_REPOS_URL, type HttpFetch } from './repoRegistry.js';

const ROW_A = { slug: 'owner/app', path: '/repos/app', attachedAt: '2026-01-01T00:00:00Z', state: 'active' };
const ROW_B = { slug: 'owner/other', path: '/repos/other', attachedAt: '2026-01-02T00:00:00Z', state: 'paused' };

function fakeFetch(status: number, body: unknown, ok = status >= 200 && status < 300): HttpFetch {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

describe('createRepoRegistryClient', () => {
  describe('list', () => {
    it('returns the parsed rows and calls GET on the base URL', async () => {
      const fetch = fakeFetch(200, { repos: [ROW_A, ROW_B] });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: true, repos: [ROW_A, ROW_B] });
      expect(fetch).toHaveBeenCalledWith(DEFAULT_REPOS_URL, { method: 'GET' });
    });

    it('drops a malformed row and keeps its well-formed sibling', async () => {
      const badRow = { slug: 'owner/bad', attachedAt: '2026-01-01T00:00:00Z', state: 'active' };
      const fetch = fakeFetch(200, { repos: [badRow, ROW_A] });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: true, repos: [ROW_A] });
    });

    it('drops a row with an invalid state', async () => {
      const badRow = { ...ROW_A, slug: 'owner/bad', state: 'bogus' };
      const fetch = fakeFetch(200, { repos: [badRow] });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: true, repos: [] });
    });

    it('fails for a non-array repos field', async () => {
      const fetch = fakeFetch(200, { repos: {} });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: false, error: 'unexpected response from factoryd' });
    });

    it('fails for a non-object payload', async () => {
      const fetch = fakeFetch(200, null);
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: false, error: 'unexpected response from factoryd' });
    });

    it('carries through a thrown fetch error message', async () => {
      const fetch: HttpFetch = vi.fn(async () => {
        throw new Error('network down');
      });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: false, error: 'network down' });
    });

    it('stringifies a thrown non-Error value', async () => {
      const fetch: HttpFetch = vi.fn(async () => {
        throw 'nope';
      });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.list();
      expect(result).toEqual({ ok: false, error: 'nope' });
    });
  });

  describe('pause / resume', () => {
    it('pause POSTs /repos/<slug>/pause and returns the parsed repo', async () => {
      const fetch = fakeFetch(200, { repo: ROW_A });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.pause('owner/app');
      expect(result).toEqual({ ok: true, repo: ROW_A });
      expect(fetch).toHaveBeenCalledWith('/repos/owner/app/pause', { method: 'POST' });
    });

    it('resume POSTs /repos/<slug>/resume and returns the parsed repo', async () => {
      const fetch = fakeFetch(200, { repo: ROW_B });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.resume('owner/other');
      expect(result).toEqual({ ok: true, repo: ROW_B });
      expect(fetch).toHaveBeenCalledWith('/repos/owner/other/resume', { method: 'POST' });
    });
  });

  describe('detach', () => {
    it('DELETEs /repos/<slug> and returns ok for a 202 draining entry', async () => {
      const draining = { ...ROW_A, state: 'draining' as const };
      const fetch = fakeFetch(202, { repo: draining });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.detach('owner/app');
      expect(result).toEqual({ ok: true, repo: draining });
      expect(fetch).toHaveBeenCalledWith('/repos/owner/app', { method: 'DELETE' });
    });

    it('DELETEs /repos/<slug> and returns ok for a 200 tombstone', async () => {
      const detached = { ...ROW_A, state: 'detached' as const };
      const fetch = fakeFetch(200, { repo: detached });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.detach('owner/app');
      expect(result).toEqual({ ok: true, repo: detached });
    });
  });

  describe('error responses', () => {
    it('surfaces a 404 unknown-repo error', async () => {
      const fetch = fakeFetch(404, { error: 'owner/app is not attached', reason: 'unknown-repo' });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.pause('owner/app');
      expect(result).toEqual({ ok: false, error: 'owner/app is not attached' });
    });

    it('surfaces a 409 detached error', async () => {
      const fetch = fakeFetch(409, { error: 'owner/app is detached; re-attach it', reason: 'detached' });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.resume('owner/app');
      expect(result).toEqual({ ok: false, error: 'owner/app is detached; re-attach it' });
    });

    it('falls back to a status message when the error body cannot be parsed', async () => {
      const fetch: HttpFetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('bad json');
        },
      }));
      const client = createRepoRegistryClient({ fetch });
      const result = await client.detach('owner/app');
      expect(result).toEqual({ ok: false, error: 'factoryd responded 500' });
    });

    it('falls back to a status message when the error body has no error string', async () => {
      const fetch = fakeFetch(500, { whoops: true });
      const client = createRepoRegistryClient({ fetch });
      const result = await client.detach('owner/app');
      expect(result).toEqual({ ok: false, error: 'factoryd responded 500' });
    });
  });

  it('returns ok:false when a 2xx body cannot be parsed as JSON', async () => {
    const fetch: HttpFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected end of input');
      },
    }));
    const client = createRepoRegistryClient({ fetch });
    const result = await client.list();
    expect(result).toEqual({ ok: false, error: 'unexpected end of input' });
  });

  it('returns ok:false when a 2xx body has no parsable repo', async () => {
    const fetch = fakeFetch(200, { nope: true });
    const client = createRepoRegistryClient({ fetch });
    const result = await client.pause('owner/app');
    expect(result).toEqual({ ok: false, error: 'unexpected response from factoryd' });
  });

  describe('default construction', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('uses globalThis.fetch when no fetch is supplied', async () => {
      const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ repos: [ROW_A] }) }));
      vi.stubGlobal('fetch', spy);
      const client = createRepoRegistryClient();
      const result = await client.list();
      expect(result).toEqual({ ok: true, repos: [ROW_A] });
      expect(spy).toHaveBeenCalledWith(DEFAULT_REPOS_URL, { method: 'GET' });
    });

    it('honours a custom baseUrl', async () => {
      const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ repos: [] }) }));
      vi.stubGlobal('fetch', spy);
      const client = createRepoRegistryClient({ baseUrl: 'http://example.test/repos' });
      await client.list();
      expect(spy).toHaveBeenCalledWith('http://example.test/repos', { method: 'GET' });
    });
  });
});
