import { expect, it } from 'vitest';

import { fakeOctokit } from './fake-octokit.js';

it('serves responses, records calls in order and leaves unconfigured endpoints undefined', async () => {
  const { octokit, calls } = fakeOctokit({ 'issues.get': { data: 1 }, request: async () => ({ status: 200 }) });
  expect(await octokit.rest.issues.get({ n: 1 })).toEqual({ data: 1 });
  expect(await octokit.request('GET /x')).toEqual({ status: 200 });
  expect(calls).toEqual([
    ['issues.get', { n: 1 }],
    ['request', 'GET /x'],
  ]);
  expect(octokit.rest.issues.list).toBeUndefined();
});
