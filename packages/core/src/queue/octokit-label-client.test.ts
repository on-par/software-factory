// packages/core/src/queue/octokit-label-client.test.ts — Repo-label cleanup for claim leases via the Octokit client (#1623).

import { describe, expect, it, vi } from 'vitest';

import { claimedByLabel, createGithubQueue, createOctokitQueueClient, IN_PROGRESS_LABEL } from './github-queue.js';
import { REPO_LABEL_SWEEP_MAX_PAGES } from './octokit-label-client.js';

function fakeOctokit(opts: { issues: Array<{ number: number; labels: string[] }>; repoLabels?: string[] }) {
  const state = new Map(opts.issues.map((i) => [i.number, new Set(i.labels)]));
  const repoLabels = new Set(opts.repoLabels ?? opts.issues.flatMap((i) => i.labels));
  const deleteLabel = vi.fn(async ({ name }: { name: string }) => {
    repoLabels.delete(name);
    return {};
  });
  const issues = {
    listForRepo: vi.fn(
      async ({
        labels,
        page,
      }: {
        labels?: string;
        page?: number;
      }): Promise<{ data: Array<Record<string, unknown>> }> => {
        if ((page ?? 1) > 1) return { data: [] };
        const want = labels ? labels.split(',') : [];
        return {
          data: [...state]
            .filter(([, set]) => want.every((l) => set.has(l)))
            .map(([number, set]) => ({ number, labels: [...set] })),
        };
      },
    ),
    listLabelsOnIssue: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
      data: [...(state.get(issue_number) ?? [])].map((name) => ({ name })),
    })),
    addLabels: vi.fn(async ({ issue_number, labels }: { issue_number: number; labels: string[] }) => {
      for (const l of labels) state.get(issue_number)?.add(l);
      return {};
    }),
    removeLabel: vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
      state.get(issue_number)?.delete(name);
      return {};
    }),
    createLabel: vi.fn(async ({ name }: { name: string }) => {
      repoLabels.add(name);
      return {};
    }),
    listLabelsForRepo: vi.fn(async ({ page }: { page: number }) => ({
      data: [...repoLabels].slice((page - 1) * 100, page * 100).map((name) => ({ name })),
    })),
    deleteLabel,
  };
  return { octokit: { rest: { issues } } as any, issues, state, repoLabels, deleteLabel };
}

function heartbeatQueue(octokit: unknown) {
  return createGithubQueue({
    client: createOctokitQueueClient(octokit as any),
    owner: 'o',
    repo: 'r',
    claimantId: 'aaa-1',
    now: () => 1_000_000,
    leaseMs: 300_000,
  });
}

const claimed = (...extra: string[]) => [IN_PROGRESS_LABEL, claimedByLabel('aaa-1'), ...extra];

describe('heartbeat repo-label cleanup (#1623)', () => {
  it('heartbeat deletes the replaced claim-expires repo label (#1623)', async () => {
    const f = fakeOctokit({ issues: [{ number: 7, labels: claimed('factory:claim-expires:1000') }] });
    await expect(heartbeatQueue(f.octokit).heartbeat(7)).resolves.toBe(true);
    expect(f.deleteLabel).toHaveBeenCalledTimes(1);
    expect(f.deleteLabel).toHaveBeenCalledWith({ owner: 'o', repo: 'r', name: 'factory:claim-expires:1000' });
    expect(f.repoLabels.has('factory:claim-expires:1000')).toBe(false);
    expect(f.state.get(7)).toContain('factory:claim-expires:1300');
  });

  it('heartbeat ignores a 404 when the replaced claim-expires label is already gone (#1623)', async () => {
    const f = fakeOctokit({ issues: [{ number: 7, labels: claimed('factory:claim-expires:1000') }] });
    f.deleteLabel.mockRejectedValueOnce({ status: 404 });
    await expect(heartbeatQueue(f.octokit).heartbeat(7)).resolves.toBe(true);
    expect(f.state.get(7)).toContain('factory:claim-expires:1300');
    expect(f.state.get(7)).not.toContain('factory:claim-expires:1000');
  });

  it('heartbeat keeps a replaced label another open issue still carries', async () => {
    const f = fakeOctokit({
      issues: [
        { number: 7, labels: claimed('factory:claim-expires:1000') },
        { number: 8, labels: ['factory:claim-expires:1000'] },
      ],
    });
    await expect(heartbeatQueue(f.octokit).heartbeat(7)).resolves.toBe(true);
    expect(f.deleteLabel).not.toHaveBeenCalled();
  });

  it('heartbeat still succeeds when deleteLabel fails with 500', async () => {
    const f = fakeOctokit({ issues: [{ number: 7, labels: claimed('factory:claim-expires:1000') }] });
    f.deleteLabel.mockRejectedValueOnce({ status: 500 });
    await expect(heartbeatQueue(f.octokit).heartbeat(7)).resolves.toBe(true);
  });
});

describe('createOctokitQueueClient repo-label sweep methods (#1623)', () => {
  it('listRepoLabels pages until a short page', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `l${i}`);
    const f = fakeOctokit({ issues: [], repoLabels: names });
    const client = createOctokitQueueClient(f.octokit);
    await expect(client.listRepoLabels!({ owner: 'o', repo: 'r' })).resolves.toEqual(names);
    expect(f.issues.listLabelsForRepo).toHaveBeenCalledTimes(3);
  });

  it('listRepoLabels throws past the page cap instead of returning a partial list', async () => {
    const f = fakeOctokit({ issues: [] });
    f.issues.listLabelsForRepo.mockImplementation(async () => ({
      data: Array.from({ length: 100 }, () => ({ name: 'x' })),
    }));
    const client = createOctokitQueueClient(f.octokit);
    await expect(client.listRepoLabels!({ owner: 'o', repo: 'r' })).rejects.toThrow(/exceeded/);
    expect(f.issues.listLabelsForRepo).toHaveBeenCalledTimes(REPO_LABEL_SWEEP_MAX_PAGES);
  });

  it('listAllOpenIssues pages, keeps PRs and normalises labels', async () => {
    const f = fakeOctokit({ issues: [] });
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        number: i + 1,
        labels: i === 0 ? ['a', { name: 'b' }, { name: '' }, {}] : [],
        ...(i === 1 ? { pull_request: {} } : {}),
      }));
    f.issues.listForRepo.mockResolvedValueOnce({ data: page(100) }).mockResolvedValueOnce({ data: page(3) });
    const client = createOctokitQueueClient(f.octokit);
    const all = await client.listAllOpenIssues!({ owner: 'o', repo: 'r' });
    expect(all).toHaveLength(103);
    expect(all[0]!.labels).toEqual(['a', 'b']);
  });

  it('listAllOpenIssues throws past the page cap', async () => {
    const f = fakeOctokit({ issues: [] });
    f.issues.listForRepo.mockImplementation(async () => ({
      data: Array.from({ length: 100 }, (_, i) => ({ number: i, labels: [] })),
    }));
    const client = createOctokitQueueClient(f.octokit);
    await expect(client.listAllOpenIssues!({ owner: 'o', repo: 'r' })).rejects.toThrow(/exceeded/);
  });

  it('deleteRepoLabel swallows 404, rethrows 500, and evicts the label cache', async () => {
    const f = fakeOctokit({ issues: [], repoLabels: ['gone'] });
    const client = createOctokitQueueClient(f.octokit);
    await client.ensureLabel({ owner: 'o', repo: 'r', name: 'gone', color: 'fff', description: '' });
    f.deleteLabel.mockRejectedValueOnce({ status: 404 });
    await expect(client.deleteRepoLabel!({ owner: 'o', repo: 'r', name: 'gone' })).resolves.toBeUndefined();
    await expect(
      client.ensureLabel({ owner: 'o', repo: 'r', name: 'gone', color: 'fff', description: '' }),
    ).resolves.toBe(true);
    f.deleteLabel.mockRejectedValueOnce({ status: 500 });
    await expect(client.deleteRepoLabel!({ owner: 'o', repo: 'r', name: 'x' })).rejects.toMatchObject({ status: 500 });
  });
});
