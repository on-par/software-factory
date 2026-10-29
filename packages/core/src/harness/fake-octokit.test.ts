import { describe, expect, it } from 'vitest';

import { fakeOctokit } from './fake-octokit.js';

describe('fakeOctokit', () => {
  it('returns static responses and handler results per endpoint', async () => {
    const { octokit } = fakeOctokit({
      'issues.get': { data: 1 },
      'pulls.list': (args: unknown) => ({ data: args }),
      'users.getAuthenticated': async () => ({ data: { id: 7 } }),
    });
    expect(await octokit.rest.issues.get({ n: 1 })).toEqual({ data: 1 });
    expect(await octokit.rest.pulls.list({ page: 2 })).toEqual({ data: { page: 2 } });
    expect(await octokit.rest.users.getAuthenticated()).toEqual({ data: { id: 7 } });
  });

  it('records every call with its endpoint and args in order', async () => {
    const { octokit, calls } = fakeOctokit({
      'issues.get': { data: 1 },
      'pulls.list': { data: [] },
      graphql: { ok: true },
    });
    await octokit.rest.issues.get({ a: 1 });
    await octokit.graphql('query Q', { v: 2 });
    await octokit.rest.pulls.list({ b: 3 });
    expect(calls).toEqual([
      ['issues.get', { a: 1 }],
      ['graphql', 'query Q', { v: 2 }],
      ['pulls.list', { b: 3 }],
    ]);
  });

  it('leaves unconfigured endpoints undefined', async () => {
    const { octokit } = fakeOctokit({
      'issues.get': () => {
        throw new Error('boom');
      },
    });
    expect(octokit.rest.pulls).toBeUndefined();
    expect(octokit.graphql).toBeUndefined();
    expect(octokit.rest.issues.list).toBeUndefined();
    await expect(octokit.rest.issues.get()).rejects.toThrow('boom');
  });

  it('mounts dotless keys as recorded top-level methods', async () => {
    const { octokit, calls } = fakeOctokit({
      paginate: async (fn: any, args: any) => (await fn(args)).data,
      request: { data: [1] },
      'issues.list': { data: [2] },
    });
    expect(await octokit.paginate(octokit.rest.issues.list, { a: 1 })).toEqual([2]);
    expect(await octokit.request('GET /x', { b: 2 })).toEqual({ data: [1] });
    expect(octokit.rest.paginate).toBeUndefined();
    expect(calls).toEqual([
      ['paginate', octokit.rest.issues.list, { a: 1 }],
      ['issues.list', { a: 1 }],
      ['request', 'GET /x', { b: 2 }],
    ]);
  });
});
