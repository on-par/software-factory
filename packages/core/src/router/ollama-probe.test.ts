import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchFn } from './index.js';
import { claimOllamaSkipNotice, ollamaEndpoint, probeOllama, resetOllamaProbeCache } from './ollama-probe.js';

const EP = 'http://127.0.0.1:11434';
const response = (ok: boolean, status: number) => ({
  ok,
  status,
  statusText: '',
  text: async () => '',
  json: async () => ({}),
});
const okFetch = () => vi.fn<FetchFn>(async () => response(true, 200));

describe('probeOllama', () => {
  beforeEach(resetOllamaProbeCache);

  it('is reachable on a 200 and GETs /api/version', async () => {
    const fetchFn = okFetch();
    expect(await probeOllama(fetchFn, EP)).toEqual({ reachable: true, endpoint: EP });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${EP}/api/version`);
    expect(init?.method).toBe('GET');
  });

  it('is unreachable on non-2xx', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => response(false, 503));
    expect(await probeOllama(fetchFn, EP)).toEqual({ reachable: false, endpoint: EP, reason: 'HTTP 503' });
  });

  it('reports the cause code or message on rejection', async () => {
    const refused = vi.fn<FetchFn>(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const r = await probeOllama(refused, EP);
    expect(r.reachable === false && r.reason).toContain('ECONNREFUSED');

    resetOllamaProbeCache();
    const plain = vi.fn<FetchFn>(async () => {
      throw new Error('boom');
    });
    const p = await probeOllama(plain, EP);
    expect(p.reachable === false && p.reason).toBe('boom');
  });

  it('reports a timeout', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const r = await probeOllama(fetchFn, EP);
    expect(r.reachable === false && r.reason).toBe('timed out after 1500ms');
  });

  it('shares one in-flight probe across concurrent callers and caches per endpoint', async () => {
    const fetchFn = okFetch();
    await Promise.all([probeOllama(fetchFn, EP), probeOllama(fetchFn, EP)]);
    await probeOllama(fetchFn, EP);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await probeOllama(fetchFn, 'http://other:11434');
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
