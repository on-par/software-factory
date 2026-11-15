import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchFn } from './index.js';
import { claimOllamaSkipNotice, ollamaEndpoint, probeOllama, resetOllamaProbeCache } from './ollama-probe.js';
import { recordArgs } from '../test-support/recorders.js';

const EP = 'http://127.0.0.1:11434';
const res = (ok: boolean, s: number) => ({ ok, status: s, statusText: '', text: async () => '', json: async () => 0 });
const okFetch = () => recordArgs(async (_url: string, _init?: RequestInit) => res(true, 200));

describe('probeOllama', () => {
  beforeEach(resetOllamaProbeCache);

  it('is reachable on a 200 and GETs /api/version', async () => {
    const { fn: fetchFn, calls } = okFetch();
    expect(await probeOllama(fetchFn, EP)).toEqual({ reachable: true, endpoint: EP });
    expect(calls[0]![0]).toBe(`${EP}/api/version`);
    expect(calls[0]![1]?.method).toBe('GET');
  });

  it('is unreachable on non-2xx', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => res(false, 503));
    expect(await probeOllama(fetchFn, EP)).toEqual({ reachable: false, endpoint: EP, reason: 'HTTP 503' });
  });

  it('reports the cause code or message on rejection', async () => {
    const refused = vi.fn<FetchFn>(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const r = await probeOllama(refused, EP);
    expect(!r.reachable && r.reason).toContain('ECONNREFUSED');

    resetOllamaProbeCache();
    const plain = vi.fn<FetchFn>(async () => {
      throw new Error('boom');
    });
    const p = await probeOllama(plain, EP);
    expect(!p.reachable && p.reason).toBe('boom');
  });

  it('reports a timeout', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const r = await probeOllama(fetchFn, EP);
    expect(!r.reachable && r.reason).toBe('timed out after 1500ms');
  });

  it('shares one in-flight probe across concurrent callers and caches per endpoint', async () => {
    const { fn: fetchFn, calls } = okFetch();
    await Promise.all([probeOllama(fetchFn, EP), probeOllama(fetchFn, EP)]);
    await probeOllama(fetchFn, EP);
    expect(calls).toHaveLength(1);
    await probeOllama(fetchFn, 'http://other:11434');
    expect(calls).toHaveLength(2);
  });
});

describe('ollamaEndpoint', () => {
  it('honors OLLAMA_BASE_URL and strips trailing slashes', () => {
    expect(ollamaEndpoint({ OLLAMA_BASE_URL: 'http://h:1///' })).toBe('http://h:1');
  });

  it('falls back on unset or empty', () => {
    expect(ollamaEndpoint({})).toBe(EP);
    expect(ollamaEndpoint({ OLLAMA_BASE_URL: '' })).toBe(EP);
  });
});

describe('claimOllamaSkipNotice', () => {
  beforeEach(resetOllamaProbeCache);

  it('is true once, then false; reset re-arms it', () => {
    expect(claimOllamaSkipNotice()).toBe(true);
    expect(claimOllamaSkipNotice()).toBe(false);
    resetOllamaProbeCache();
    expect(claimOllamaSkipNotice()).toBe(true);
  });
});
