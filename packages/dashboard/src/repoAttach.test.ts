import { describe, expect, it, vi } from 'vitest';

import { attachRepo, DEFAULT_REPOS_URL, explainAttachFailure, validateAttachInput } from './repoAttach.js';

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('explainAttachFailure', () => {
  it('explains a missing factory config', () => {
    const explanation = explainAttachFailure('missing-factory-config', '/repo/.factory/config.json not found');
    expect(explanation.reason).toBe('missing-factory-config');
    expect(explanation.title).toContain('Factory config');
    expect(explanation.remediation).toContain('.factory/config.json');
    expect(explanation.remediation).toContain('factory init');
    expect(explanation.detail).toBe('/repo/.factory/config.json not found');
  });

  it('explains an origin mismatch', () => {
    const detail = 'origin is on-par/other-repo, not on-par/software-factory';
    const explanation = explainAttachFailure('origin-mismatch', detail);
    expect(explanation.reason).toBe('origin-mismatch');
    expect(explanation.title).toContain('does not match');
    expect(explanation.detail).toBe(detail);
  });

  it('falls back to unknown-failure for an unrecognized reason', () => {
    const explanation = explainAttachFailure('something-new-from-a-newer-daemon', 'whatever');
    expect(explanation.reason).toBe('unknown-failure');
    expect(explanation.detail).toBe('whatever');
  });
});

describe('validateAttachInput', () => {
  it('returns no errors when both fields carry non-blank text', () => {
    expect(validateAttachInput({ repo: 'on-par/software-factory', path: '/tmp/checkout' })).toEqual({});
  });

  it('flags an empty repo slug', () => {
    const errors = validateAttachInput({ repo: '', path: '/tmp/checkout' });
    expect(errors.repo).toBe('Enter a GitHub repo slug (owner/name).');
    expect(errors.path).toBeUndefined();
  });

  it('flags a whitespace-only checkout path', () => {
    const errors = validateAttachInput({ repo: 'on-par/software-factory', path: '   ' });
    expect(errors.path).toBe('Enter the absolute local checkout path.');
    expect(errors.repo).toBeUndefined();
  });

  it('flags both fields when both are blank', () => {
    const errors = validateAttachInput({ repo: '  ', path: '' });
    expect(errors.repo).toBe('Enter a GitHub repo slug (owner/name).');
    expect(errors.path).toBe('Enter the absolute local checkout path.');
  });
});

describe('attachRepo', () => {
  it('posts DEFAULT_REPOS_URL with the JSON body and returns ok on 201', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(201, {}));
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/tmp/checkout' }, { fetch: fetchFn });

    expect(outcome).toEqual({ ok: true, slug: 'on-par/software-factory' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    if (!init) throw new Error('expected a request init');
    expect(url).toBe(DEFAULT_REPOS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ repo: 'on-par/software-factory', path: '/tmp/checkout' });
  });

  it('returns the missing-factory-config explanation on a 400 rejection', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(400, { error: '/repo/.factory/config.json not found', reason: 'missing-factory-config' }),
    );
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('missing-factory-config');
    expect(outcome.explanation.detail).toBe('/repo/.factory/config.json not found');
  });

  it('returns the origin-mismatch explanation on a 400 rejection', async () => {
    const detail = 'origin is on-par/other-repo, not on-par/software-factory';
    const fetchFn = vi.fn(async () => fakeResponse(400, { error: detail, reason: 'origin-mismatch' }));
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('origin-mismatch');
    expect(outcome.explanation.detail).toBe(detail);
  });

  it('falls back to unknown-failure with the HTTP status when the body has neither error nor reason', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(400, {}));
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('unknown-failure');
    expect(outcome.explanation.detail).toBe('factoryd returned HTTP 400');
  });

  it('returns an explanation rather than throwing when the response body is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('not json{{{', { status: 400 }));
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('unknown-failure');
    expect(outcome.explanation.detail).toBe('factoryd returned HTTP 400');
  });

  it('returns daemon-unreachable when fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('daemon-unreachable');
    expect(outcome.explanation.detail).toBe('fetch failed');
  });

  it('stringifies a non-Error throw from fetch', async () => {
    const fetchFn = vi.fn(async () => {
      throw 'connection refused';
    });
    const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' }, { fetch: fetchFn });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.explanation.reason).toBe('daemon-unreachable');
    expect(outcome.explanation.detail).toBe('connection refused');
  });

  it('defaults to globalThis.fetch when no fetch dep is injected', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(201, {}));
    vi.stubGlobal('fetch', fetchFn);

    try {
      const outcome = await attachRepo({ repo: 'on-par/software-factory', path: '/repo' });
      expect(outcome).toEqual({ ok: true, slug: 'on-par/software-factory' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
