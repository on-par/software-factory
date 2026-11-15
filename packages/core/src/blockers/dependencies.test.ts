import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { addBlockedBy, listBlockedBy } from './dependencies.js';

const toOctokit = (fake: any): Octokit => fake;

const GET_ROUTE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const POST_ROUTE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';

function makeDeps(request: (route: string, params?: unknown) => Promise<unknown>) {
  return { octokit: toOctokit({ request }), repo: 'on-par/software-factory' };
}

function recordingRequest(...responses: unknown[]) {
  const calls: Array<[string, unknown]> = [];
  const request = async (route: string, params?: unknown) => {
    calls.push([route, params]);
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  return { request, calls };
}

describe('blocked_by REST contract', () => {
  it('lists with the exact GET route and params', async () => {
    const { request, calls } = recordingRequest({ data: [] });
    await listBlockedBy(makeDeps(request), 7);
    expect(calls).toEqual([
      [GET_ROUTE, { owner: 'on-par', repo: 'software-factory', issue_number: 7, per_page: 100, page: 1 }],
    ]);
  });

  it('adds with the exact POST route and the blocker database id', async () => {
    const { request, calls } = recordingRequest({});
    await addBlockedBy(makeDeps(request), 7, 9001);
    expect(calls).toEqual([
      [POST_ROUTE, { owner: 'on-par', repo: 'software-factory', issue_number: 7, issue_id: 9001 }],
    ]);
  });
});

describe('listBlockedBy mapping', () => {
  it('maps repository, state and stateReason variants', async () => {
    const request = async () => ({
      data: [
        { number: 1, state: 'closed', state_reason: 'completed', repository: { full_name: 'a/b' } },
        { number: 2, state: 'open', repository_url: 'https://api.github.com/repos/c/d' },
        { number: 3 },
      ],
    });
    await expect(listBlockedBy(makeDeps(request), 7)).resolves.toEqual([
      { number: 1, state: 'closed', stateReason: 'completed', repository: 'a/b' },
      { number: 2, state: 'open', stateReason: null, repository: 'c/d' },
      { number: 3, state: 'open', stateReason: null, repository: 'on-par/software-factory' },
    ]);
  });

  it('fails closed on a non-array payload', async () => {
    const request = async () => ({ data: { message: 'nope' } });
    await expect(listBlockedBy(makeDeps(request), 7)).rejects.toThrow('did not return an array');
  });

  it('propagates request errors', async () => {
    const request = async () => {
      throw new Error('boom');
    };
    await expect(listBlockedBy(makeDeps(request), 7)).rejects.toThrow('boom');
    await expect(addBlockedBy(makeDeps(request), 7, 1)).rejects.toThrow('boom');
  });
});

it('fetches every page and rejects malformed later pages', async () => {
  const page = Array.from({ length: 100 }, (_, number) => ({ number }));
  const ok = recordingRequest({ data: page }, { data: [{ number: 100 }] });
  expect(await listBlockedBy(makeDeps(ok.request), 7)).toHaveLength(101);
  expect(ok.calls[1]?.[1]).toMatchObject({ page: 2, per_page: 100 });
  const bad = recordingRequest({ data: page }, { data: {} });
  await expect(listBlockedBy(makeDeps(bad.request), 7)).rejects.toThrow('did not return an array');
});
