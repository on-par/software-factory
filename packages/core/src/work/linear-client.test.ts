import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLinearClient, LinearApiError } from './linear-client.js';

const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/linear-issue-on-12.json', import.meta.url), 'utf8'));

const bodyText = (body: unknown): string => (typeof body === 'string' ? body : '');

function respond(body: unknown, status = 200) {
  const requests: Array<[string | Request | URL, RequestInit | undefined]> = [];
  const fetch = async (url: string | Request | URL, init?: RequestInit) => {
    requests.push([url, init]);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, requests };
}

describe('createLinearClient', () => {
  it('posts the issue query with the API key to the Linear GraphQL endpoint', async () => {
    const { fetch, requests } = respond(fixture);
    await createLinearClient({ apiKey: 'test-key', fetch }).fetchIssue('ON-12');

    const [url, init] = requests[0] ?? [];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'test-key' });
    expect(JSON.parse(bodyText(init?.body)).variables).toEqual({ id: 'ON-12' });
  });

  it('returns a normalized record', async () => {
    const body = structuredClone(fixture);
    body.data.issue.description = null;
    const record = await createLinearClient({ apiKey: 'k', fetch: respond(body).fetch }).fetchIssue('ON-12');

    expect(record.description).toBe('');
    expect(record.labels).toEqual(['factory:ready', 'enhancement']);
    expect(record.stateType).toBe('started');
    expect(record.identifier).toBe('ON-12');
  });

  it('rejects a response that fails the schema', async () => {
    const body = structuredClone(fixture);
    body.data.issue.title = 5;
    const p = createLinearClient({ apiKey: 'k', fetch: respond(body).fetch }).fetchIssue('ON-12');

    await expect(p).rejects.toBeInstanceOf(LinearApiError);
    await expect(p).rejects.toThrow(/malformed Linear response for ON-12/);
  });

  it('rejects a GraphQL errors payload', async () => {
    const p = createLinearClient({ apiKey: 'k', fetch: respond({ errors: [{ message: 'boom' }] }).fetch }).fetchIssue(
      'ON-12',
    );

    await expect(p).rejects.toBeInstanceOf(LinearApiError);
    await expect(p).rejects.toThrow(/boom/);
  });

  it('rejects a non-2xx response without leaking the key', async () => {
    const p = createLinearClient({ apiKey: 'secret-key', fetch: respond({}, 401).fetch }).fetchIssue('ON-12');

    await expect(p).rejects.toThrow(/HTTP 401/);
    await expect(p).rejects.not.toThrow(/secret-key/);
  });

  it('rejects a null issue as not found', async () => {
    const p = createLinearClient({ apiKey: 'k', fetch: respond({ data: { issue: null } }).fetch }).fetchIssue('ON-99');

    await expect(p).rejects.toThrow('Linear issue ON-99 not found');
  });
});
