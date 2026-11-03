import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLinearClient, LINEAR_GRAPHQL_URL } from './linear-client.js';

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/linear/issue-on-12.json', import.meta.url), 'utf8'),
);

describe('createLinearClient', () => {
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

  it('returns a typed record from a recorded response', async () => {
    const fetch = fetchReturning(fixture);
    const client = createLinearClient({ apiKey: () => 'test-key', fetch });

    const record = await client.fetchIssue('ON-12');

    expect(record).toEqual({
      id: '00000000-0000-4000-8000-000000000012',
      identifier: 'ON-12',
      title: 'Add a widget',
      description: 'Please add a widget.\n\n## Acceptance criteria\n\n- [ ] the widget exists\n',
      url: 'https://linear.app/acme/issue/ON-12/add-a-widget',
      stateType: 'started',
      labels: ['feature', 'factory'],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    const url = call?.[0];
    const init = call?.[1];
    expect(url).toBe(LINEAR_GRAPHQL_URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('test-key');
    expect(JSON.parse(String(init?.body)).variables.id).toBe('ON-12');
  });

  it('rejects a response that fails schema validation', async () => {
    const client = createLinearClient({
      apiKey: () => 'test-key',
      fetch: fetchReturning({ data: { issue: { id: 1, title: 'x' } } }),
    });
    await expect(client.fetchIssue('ON-12')).rejects.toThrow(/unexpected response/);
  });

  it('rejects a GraphQL errors payload', async () => {
    const client = createLinearClient({
      apiKey: () => 'test-key',
      fetch: fetchReturning({ errors: [{ message: 'Entity not found' }] }),
    });
    await expect(client.fetchIssue('ON-12')).rejects.toThrow(/Entity not found/);
  });

  it('rejects a non-2xx response without leaking the key', async () => {
    const client = createLinearClient({ apiKey: () => 'secret-key-value', fetch: fetchReturning({}, 401) });
    const failure = client.fetchIssue('ON-12');
    await expect(failure).rejects.toThrow(/HTTP 401/);
    await expect(failure).rejects.not.toThrow(/secret-key-value/);
  });

  it('rejects a null issue as not found', async () => {
    const client = createLinearClient({
      apiKey: () => 'test-key',
      fetch: fetchReturning({ data: { issue: null } }),
    });
    await expect(client.fetchIssue('ON-12')).rejects.toThrow(/not found/);
  });

  it('fails before fetching when no API key is set', async () => {
    const fetch = fetchReturning(fixture);
    const client = createLinearClient({ apiKey: () => undefined, fetch });
    await expect(client.fetchIssue('ON-12')).rejects.toThrow(/LINEAR_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
