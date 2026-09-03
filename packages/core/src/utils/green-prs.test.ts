// packages/core/src/utils/green-prs.test.ts
import { describe, expect, it, vi } from 'vitest';

import {
  findUnmergedGreenPrs,
  type GreenPrGitHubClient,
  type OpenPullRequestSummary,
  owningIssueForPr,
} from './green-prs.js';

function pr(overrides: Partial<OpenPullRequestSummary> = {}): OpenPullRequestSummary {
  return {
    number: 1,
    branch: 'ship-it/939-fix-thing',
    headSha: 'sha1',
    title: 'a pr',
    body: 'Closes #939',
    draft: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeClient(
  prs: OpenPullRequestSummary[],
  checkRunsByRef: Record<string, Array<{ status: string | null; conclusion: string | null }>>,
): GreenPrGitHubClient {
  return {
    listOpenPullRequests: vi.fn(async () => prs),
    listCheckRuns: vi.fn(async ({ ref }) => checkRunsByRef[ref] ?? []),
  };
}

describe('owningIssueForPr', () => {
  it('reads Closes #939 from a body', () => {
    expect(owningIssueForPr({ body: 'Closes #939', branch: 'main' })).toBe(939);
  });

  it('is case-insensitive and accepts fixes/resolved', () => {
    expect(owningIssueForPr({ body: 'fixes #10', branch: 'main' })).toBe(10);
    expect(owningIssueForPr({ body: 'RESOLVED #11', branch: 'main' })).toBe(11);
    expect(owningIssueForPr({ body: 'CLOSES #12', branch: 'main' })).toBe(12);
  });

  it('falls back to the branch when the body is null or has no keyword', () => {
    expect(owningIssueForPr({ body: null, branch: 'ship-it/939-fix-thing' })).toBe(939);
    expect(owningIssueForPr({ body: 'no keyword here', branch: 'ship-it/939-fix-thing' })).toBe(939);
  });

  it('returns null for a branch like main with an empty body', () => {
    expect(owningIssueForPr({ body: '', branch: 'main' })).toBeNull();
  });
});

describe('findUnmergedGreenPrs', () => {
  it('reports an open non-draft PR whose runs are all completed/success', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const now = Date.parse(createdAt) + 9 * 3_600_000;
    const client = makeClient([pr({ number: 957, headSha: 'sha1', createdAt })], {
      sha1: [{ status: 'completed', conclusion: 'success' }],
    });

    const result = await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r', now: () => now });

    expect(result).toEqual([{ number: 957, branch: 'ship-it/939-fix-thing', title: 'a pr', issue: 939, ageHours: 9 }]);
  });

  it('skips a draft PR even when its checks are green', async () => {
    const client = makeClient([pr({ draft: true, headSha: 'sha1' })], {
      sha1: [{ status: 'completed', conclusion: 'success' }],
    });

    const result = await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' });
    expect(result).toEqual([]);
    expect(client.listCheckRuns).not.toHaveBeenCalled();
  });

  it('skips a PR with zero check runs', async () => {
    const client = makeClient([pr({ headSha: 'sha1' })], { sha1: [] });
    expect(await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).toEqual([]);
  });

  it('skips a PR with a run still in_progress', async () => {
    const client = makeClient([pr({ headSha: 'sha1' })], {
      sha1: [{ status: 'in_progress', conclusion: null }],
    });
    expect(await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).toEqual([]);
  });

  it('skips a PR whose run concluded failure', async () => {
    const client = makeClient([pr({ headSha: 'sha1' })], {
      sha1: [{ status: 'completed', conclusion: 'failure' }],
    });
    expect(await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).toEqual([]);
  });

  it('skips a PR whose run concluded cancelled', async () => {
    const client = makeClient([pr({ headSha: 'sha1' })], {
      sha1: [{ status: 'completed', conclusion: 'cancelled' }],
    });
    expect(await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).toEqual([]);
  });

  it('reports a PR whose runs concluded neutral and skipped', async () => {
    const client = makeClient([pr({ number: 1, headSha: 'sha1' })], {
      sha1: [
        { status: 'completed', conclusion: 'neutral' },
        { status: 'completed', conclusion: 'skipped' },
      ],
    });
    const result = await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('returns [] when there are no open PRs', async () => {
    const client = makeClient([], {});
    expect(await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).toEqual([]);
  });

  it('propagates a listOpenPullRequests rejection to the caller', async () => {
    const client: GreenPrGitHubClient = {
      listOpenPullRequests: vi.fn(async () => {
        throw new Error('boom');
      }),
      listCheckRuns: vi.fn(async () => []),
    };
    await expect(findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' })).rejects.toThrow('boom');
  });

  it('ageHours is 0 for an unparseable createdAt', async () => {
    const client = makeClient([pr({ headSha: 'sha1', createdAt: 'not-a-date' })], {
      sha1: [{ status: 'completed', conclusion: 'success' }],
    });
    const result = await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r' });
    expect(result[0].ageHours).toBe(0);
  });

  it('ageHours is 0 for a createdAt in the future', async () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const client = makeClient([pr({ headSha: 'sha1', createdAt: '2026-01-02T00:00:00.000Z' })], {
      sha1: [{ status: 'completed', conclusion: 'success' }],
    });
    const result = await findUnmergedGreenPrs({ client, owner: 'o', repo: 'r', now: () => now });
    expect(result[0].ageHours).toBe(0);
  });
});
