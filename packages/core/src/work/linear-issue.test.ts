import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidWorkRequestInputError } from './index.js';
import { createLinearClient } from './linear-client.js';
import { createLinearIssueAdapter, parseLinearIssueKey } from './linear-issue.js';

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function load(name: string): { data: { issue: Record<string, unknown> } } {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/linear/${name}`, import.meta.url), 'utf8'));
}

function adapterFor(body: unknown) {
  const fetch = fetchReturning(body);
  return { fetch, adapter: createLinearIssueAdapter(createLinearClient({ apiKey: () => 'test-key', fetch })) };
}

describe('linear-issue adapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('live fetch');
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves ON-12 from a recorded response into an open work request', async () => {
    const { adapter, fetch } = adapterFor(load('issue-on-12.json'));
    const work = await adapter.resolve({ input: 'ON-12' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(work.key).toBe('ON-12');
    expect(work.id).toBe('linear-issue:ON-12');
    expect(work.kind).toBe('linear-issue');
    expect(work.title).toBe('Add a widget');
    expect(work.brief).toBe('Please add a widget.\n\n## Acceptance criteria\n\n- [ ] the widget exists\n');
    expect(work.acceptanceCriteria).toEqual(['the widget exists']);
    expect(work.state).toBe('open');
  });

  it('maps a canceled state type to closed', async () => {
    const { adapter } = adapterFor(load('issue-on-13-canceled.json'));
    const work = await adapter.resolve({ input: 'ON-13' });
    expect(work.state).toBe('closed');
    expect(work.brief).toBe('');
    expect(work.labels).toEqual([]);
  });

  it('maps a completed state type to closed', async () => {
    const body = load('issue-on-12.json');
    body.data.issue.state = { type: 'completed' };
    const { adapter } = adapterFor(body);
    expect((await adapter.resolve({ input: 'ON-12' })).state).toBe('closed');
  });

  it.each(['triage', 'backlog', 'unstarted', 'started', 'something-new'])(
    'maps non-terminal state types to open (%s)',
    async (type) => {
      const body = load('issue-on-12.json');
      body.data.issue.state = { type };
      const { adapter } = adapterFor(body);
      expect((await adapter.resolve({ input: 'ON-12' })).state).toBe('open');
    },
  );

  it('carries labels, url and the Linear UUID as the reference', async () => {
    const { adapter } = adapterFor(load('issue-on-12.json'));
    const work = await adapter.resolve({ input: 'ON-12' });
    expect(work.labels).toEqual(['feature', 'factory']);
    expect(work.reference).toEqual({
      externalId: '00000000-0000-4000-8000-000000000012',
      url: 'https://linear.app/acme/issue/ON-12/add-a-widget',
    });
  });

  it('rejects a GitHub issue URL with a usage error naming the expected form', async () => {
    const { adapter, fetch } = adapterFor(load('issue-on-12.json'));
    const err = await adapter
      .resolve({ input: 'https://github.com/on-par/software-factory/issues/12' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidWorkRequestInputError);
    expect((err as Error).message).toContain('ON-12');
    expect((err as Error).message).toContain('https://linear.app/<workspace>/issue/ON-12');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects other hosts and forms before any fetch', async () => {
    const { adapter, fetch } = adapterFor(load('issue-on-12.json'));
    for (const input of [
      '',
      '12',
      '#12',
      'ON-',
      'ON_12',
      'https://linear.app/acme/project/foo',
      'https://evil.example/acme/issue/ON-12',
      'https://linear.app.evil.example/acme/issue/ON-12',
      'http://linear.app/acme/issue/ON-12',
    ]) {
      expect(() => parseLinearIssueKey(input), input).toThrow(InvalidWorkRequestInputError);
      await expect(adapter.resolve({ input })).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    }
    for (const params of [null, {}, { input: 12 }]) {
      await expect(adapter.resolve(params)).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('parseLinearIssueKey', () => {
  it('parses a bare key and normalizes its case', () => {
    expect(parseLinearIssueKey('on-12')).toBe('ON-12');
    expect(parseLinearIssueKey(' ON-12 ')).toBe('ON-12');
  });

  it('parses a linear.app issue URL with or without a slug', () => {
    expect(parseLinearIssueKey('https://linear.app/acme/issue/ON-12')).toBe('ON-12');
    expect(parseLinearIssueKey('https://linear.app/acme/issue/ON-12/add-a-widget')).toBe('ON-12');
  });
});
