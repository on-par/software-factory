import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { FetchLike, FetchLikeResponse } from './github.js';
import { createGitHubContentsReader, DEFAULT_GITHUB_API_BASE_URL, DEFAULT_MAX_FILE_BYTES } from './github.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, raw: string, headers: Record<string, string> = {}): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    text: async () => raw,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(handler: (url: string) => FetchLikeResponse): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return handler(url);
  };
  return { fetch, calls };
}

function fileBody(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  return { type: 'file', size: Buffer.byteLength(content, 'utf8'), encoding: 'base64', content: base64, ...overrides };
}

describe('createGitHubContentsReader URL and headers', () => {
  it('hits the default base URL and endpoint shape', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    await reader.readFile('a.md');
    expect(calls[0]?.url).toBe(`${DEFAULT_GITHUB_API_BASE_URL}/repos/o/r/contents/a.md`);
  });

  it('sends Authorization only when a token is supplied', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const withToken = createGitHubContentsReader({ owner: 'o', repo: 'r', token: 'secret', fetch });
    await withToken.readFile('a.md');
    expect(calls[0]?.headers.Authorization).toBe('Bearer secret');

    const withoutToken = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    await withoutToken.readFile('a.md');
    expect(calls[1]?.headers.Authorization).toBeUndefined();
  });

  it('appends ?ref= only when a ref is supplied', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const withRef = createGitHubContentsReader({ owner: 'o', repo: 'r', ref: 'main', fetch });
    await withRef.readFile('a.md');
    expect(calls[0]?.url).toContain('?ref=main');

    const withoutRef = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    await withoutRef.readFile('a.md');
    expect(calls[1]?.url).not.toContain('?ref=');
  });

  it('overrides the base URL with and without a trailing slash', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const trailing = createGitHubContentsReader({
      owner: 'o',
      repo: 'r',
      baseUrl: 'https://ghe.example.com/api/v3/',
      fetch,
    });
    await trailing.readFile('a.md');
    expect(calls[0]?.url).toBe('https://ghe.example.com/api/v3/repos/o/r/contents/a.md');

    const bare = createGitHubContentsReader({
      owner: 'o',
      repo: 'r',
      baseUrl: 'https://ghe.example.com/api/v3',
      fetch,
    });
    await bare.readFile('a.md');
    expect(calls[1]?.url).toBe('https://ghe.example.com/api/v3/repos/o/r/contents/a.md');
  });

  it('percent-encodes path segments', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    await reader.readFile('docs/my file #1.md');
    expect(calls[0]?.url).toBe(`${DEFAULT_GITHUB_API_BASE_URL}/repos/o/r/contents/docs/my%20file%20%231.md`);
  });

  it('requests the repo root with no trailing slash', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, []));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    await reader.readDir('');
    expect(calls[0]?.url).toBe(`${DEFAULT_GITHUB_API_BASE_URL}/repos/o/r/contents`);
  });

  it('falls back to the global fetch when none is injected', async () => {
    const { fetch: globalFetchStub, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const original = (globalThis as { fetch?: FetchLike }).fetch;
    (globalThis as { fetch?: FetchLike }).fetch = globalFetchStub;
    try {
      const reader = createGitHubContentsReader({ owner: 'o', repo: 'r' });
      expect(await reader.readFile('a.md')).toEqual({ path: 'a.md', text: 'hi', size: 2 });
      expect(calls).toHaveLength(1);
    } finally {
      (globalThis as { fetch?: FetchLike }).fetch = original;
    }
  });
});

describe('createGitHubContentsReader readFile happy path', () => {
  it('decodes base64 content to text', async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody('hello world')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.readFile('a.md')).toEqual({ path: 'a.md', text: 'hello world', size: 11 });
  });

  it('round-trips multibyte UTF-8 content byte-for-byte', async () => {
    const text = 'héllo wörld 🚀 日本語';
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody(text)));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    const result = await reader.readFile('a.md');
    expect(result?.text).toBe(text);
    expect(result?.size).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('round-trips CRLF content byte-for-byte', async () => {
    const text = 'line one\r\nline two\r\n';
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody(text)));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect((await reader.readFile('a.md'))?.text).toBe(text);
  });

  it('returns the normalized path and reported size', async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    const result = await reader.readFile('./a//b.md');
    expect(result?.path).toBe('a/b.md');
  });

  it('defaults size to 0 when the response omits it', async () => {
    const content = Buffer.from('hi', 'utf8').toString('base64');
    const { fetch } = stubFetch(() => jsonResponse(200, { type: 'file', encoding: 'base64', content }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.readFile('a.md')).toEqual({ path: 'a.md', text: 'hi', size: 0 });
  });
});

describe('createGitHubContentsReader readFile degradations', () => {
  it('404 -> not-found', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(404, { message: 'Not Found' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'a.md', reason: 'not-found', status: 404 });
  });

  it('401 -> unauthorized', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(401, { message: 'Bad credentials' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({
      operation: 'readFile',
      path: 'a.md',
      reason: 'unauthorized',
      status: 401,
    });
  });

  it('403 with x-ratelimit-remaining: 0 -> rate-limited', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({
      operation: 'readFile',
      path: 'a.md',
      reason: 'rate-limited',
      status: 403,
    });
  });

  it('403 without the header -> unauthorized', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(403, { message: 'forbidden' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({
      operation: 'readFile',
      path: 'a.md',
      reason: 'unauthorized',
      status: 403,
    });
  });

  it('429 -> rate-limited', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(429, { message: 'too many requests' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({
      operation: 'readFile',
      path: 'a.md',
      reason: 'rate-limited',
      status: 429,
    });
  });

  it('500 -> invalid-response', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(500, { message: 'server error' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({
      operation: 'readFile',
      path: 'a.md',
      reason: 'invalid-response',
      status: 500,
    });
  });

  it('non-JSON body -> invalid-response', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => textResponse(200, 'not json{'));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'readFile', path: 'a.md', reason: 'invalid-response' }),
    );
  });

  it('a rejecting fetch -> network', async () => {
    const onDegrade = vi.fn();
    const fetch: FetchLike = async () => {
      throw new Error('boom');
    };
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'readFile', path: 'a.md', reason: 'network', detail: 'boom' }),
    );
  });

  it('a response whose text() rejects -> invalid-response', async () => {
    const onDegrade = vi.fn();
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => {
        throw new Error('stream reset');
      },
    });
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'readFile',
        path: 'a.md',
        reason: 'invalid-response',
        detail: 'stream reset',
      }),
    );
  });

  it('array body (path is a directory) -> wrong-type', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(200, [{ name: 'x', path: 'dir/x', type: 'file' }]));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('dir')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'dir', reason: 'wrong-type' });
  });

  it('size above maxFileBytes -> too-large', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody('hi', { size: 100 })));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', maxFileBytes: 10, fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'a.md', reason: 'too-large' });
  });

  it("encoding: 'none' -> too-large, even when size is within maxFileBytes", async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(200, { type: 'file', size: 10, encoding: 'none', content: '' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'a.md', reason: 'too-large' });
  });

  it("encoding: 'utf-8' -> unsupported-content", async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(200, { type: 'file', size: 2, encoding: 'utf-8', content: 'hi' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'a.md', reason: 'unsupported-content' });
  });

  it('base64 content containing a NUL byte -> unsupported-content', async () => {
    const onDegrade = vi.fn();
    const content = Buffer.from(`a${String.fromCharCode(0)}b`, 'utf8').toString('base64');
    const { fetch } = stubFetch(() => jsonResponse(200, { type: 'file', size: 3, encoding: 'base64', content }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('a.md')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: 'a.md', reason: 'unsupported-content' });
  });

  it("'../escape' -> invalid-path and never calls fetch", async () => {
    const onDegrade = vi.fn();
    const { fetch, calls } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readFile('../escape')).toBeUndefined();
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readFile', path: '../escape', reason: 'invalid-path' });
    expect(calls).toHaveLength(0);
  });
});

describe('createGitHubContentsReader readDir', () => {
  it('maps entries and sorts by path', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, [
        { name: 'b.md', path: 'dir/b.md', type: 'file' },
        { name: 'a', path: 'dir/a', type: 'dir' },
      ]),
    );
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.readDir('dir')).toEqual([
      { name: 'a', path: 'dir/a', type: 'dir' },
      { name: 'b.md', path: 'dir/b.md', type: 'file' },
    ]);
  });

  it('preserves relative order for entries with equal paths', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, [
        { name: 'a', path: 'dir/a', type: 'file' },
        { name: 'a-again', path: 'dir/a', type: 'file' },
      ]),
    );
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.readDir('dir')).toEqual([
      { name: 'a', path: 'dir/a', type: 'file' },
      { name: 'a-again', path: 'dir/a', type: 'file' },
    ]);
  });

  it('drops symlink, submodule, and malformed entries with no degrade event', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() =>
      jsonResponse(200, [
        { name: 'link', path: 'dir/link', type: 'symlink' },
        { name: 'sub', path: 'dir/sub', type: 'submodule' },
        { name: 'bad' },
        null,
        'not-an-object',
        { name: 'ok.md', path: 'dir/ok.md', type: 'file' },
      ]),
    );
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readDir('dir')).toEqual([{ name: 'ok.md', path: 'dir/ok.md', type: 'file' }]);
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it('object body (path is a file) -> wrong-type + EMPTY_DIR', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readDir('a.md')).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readDir', path: 'a.md', reason: 'wrong-type' });
  });

  it('404 -> not-found + EMPTY_DIR', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(404, { message: 'Not Found' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.readDir('nope')).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'readDir', path: 'nope', reason: 'not-found', status: 404 });
  });
});

describe('createGitHubContentsReader exists', () => {
  it('is true for a file body', async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, fileBody('hi')));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.exists('a.md')).toBe(true);
  });

  it('is true for an array body', async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, []));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch });
    expect(await reader.exists('dir')).toBe(true);
  });

  it('is false on 404 with onDegrade never called', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(404, { message: 'Not Found' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.exists('nope')).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it('is false on 403 with an exists onDegrade event', async () => {
    const onDegrade = vi.fn();
    const { fetch } = stubFetch(() => jsonResponse(403, { message: 'forbidden' }));
    const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', fetch, onDegrade });
    expect(await reader.exists('a.md')).toBe(false);
    expect(onDegrade).toHaveBeenCalledWith({ operation: 'exists', path: 'a.md', reason: 'unauthorized', status: 403 });
  });
});

describe('createGitHubContentsReader robustness', () => {
  it('degrades network / global fetch unavailable when no fetch is available', async () => {
    const onDegrade = vi.fn();
    const original = (globalThis as { fetch?: FetchLike }).fetch;
    delete (globalThis as { fetch?: FetchLike }).fetch;
    try {
      const reader = createGitHubContentsReader({ owner: 'o', repo: 'r', onDegrade });
      expect(await reader.readFile('a.md')).toBeUndefined();
      expect(onDegrade).toHaveBeenCalledWith({
        operation: 'readFile',
        path: 'a.md',
        reason: 'network',
        detail: 'global fetch is unavailable',
      });
    } finally {
      (globalThis as { fetch?: FetchLike }).fetch = original;
    }
  });

  it('does not reject when onDegrade throws', async () => {
    const { fetch } = stubFetch(() => jsonResponse(404, { message: 'Not Found' }));
    const reader = createGitHubContentsReader({
      owner: 'o',
      repo: 'r',
      fetch,
      onDegrade: () => {
        throw new Error('observer exploded');
      },
    });
    await expect(reader.readFile('a.md')).resolves.toBeUndefined();
  });
});

describe('DEFAULT_MAX_FILE_BYTES', () => {
  it('is one million bytes', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1_000_000);
  });
});
