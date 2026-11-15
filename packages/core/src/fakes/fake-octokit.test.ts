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

  it('installs dotless keys as recorded top-level methods', async () => {
    const fn = async () => ({ data: [] });
    const { octokit, calls } = fakeOctokit({
      paginate: async (f: () => Promise<{ data: unknown }>, args: unknown) => [(await f()).data, args],
      request: { status: 200 },
    });
    expect(await octokit.paginate(fn, { per_page: 5 })).toEqual([[], { per_page: 5 }]);
    expect(await octokit.request('GET /x', { a: 1 })).toEqual({ status: 200 });
    expect(calls).toEqual([
      ['paginate', fn, { per_page: 5 }],
      ['request', 'GET /x', { a: 1 }],
    ]);
  });
});
