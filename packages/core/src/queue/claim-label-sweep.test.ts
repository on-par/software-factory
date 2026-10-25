// packages/core/src/queue/claim-label-sweep.test.ts — Orphaned lease-label sweep (#1623).

import { describe, expect, it, vi } from 'vitest';

import { sweepOrphanClaimLabels } from './claim-label-sweep.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import type { QueueGitHubClient } from './github-queue.js';

function sweepClient(repoLabels: string[], openLabels: string[][], failOn: string[] = []) {
  const deleted: string[] = [];
  const client: QueueGitHubClient = {
    ...fakeIssueComments(),
    listOpenIssuesWithLabels: async () => [],
    getIssueLabels: async () => [],
    addLabels: async () => {},
    removeLabel: async () => {},
    ensureLabel: async () => false,
    listRepoLabels: vi.fn(async () => repoLabels),
    listAllOpenIssues: vi.fn(async () => openLabels.map((labels, i) => ({ number: i + 1, labels }))),
    deleteRepoLabel: vi.fn(async ({ name }: { name: string }) => {
      if (failOn.includes(name)) throw new Error(`boom ${name}`);
      deleted.push(name);
    }),
  };
  return { client, deleted };
}

const E = (n: number) => `factory:claim-expires:${n}`;

describe('sweepOrphanClaimLabels', () => {
  it('reports ran:false and reads nothing when the client lacks the sweep methods', async () => {
    const out = await sweepOrphanClaimLabels({
      client: { ...sweepClient([], []).client, listRepoLabels: undefined },
      owner: 'o',
      repo: 'r',
    });
    expect(out).toEqual({ ran: false, deleted: [], inUse: [], remaining: 0, failed: [] });
  });

  it('deletes lease-label orphans only, keeping labels on open issues and unrelated labels', async () => {
    const { client, deleted } = sweepClient(
      [E(1), E(2), 'factory:claimed-by:h-1', 'factory:claimed-by:h-2', 'bug'],
      [['bug', E(2), 'factory:claimed-by:h-2']],
    );
    const out = await sweepOrphanClaimLabels({ client, owner: 'o', repo: 'r' });
    expect(deleted).toEqual([E(1), 'factory:claimed-by:h-1']);
    expect(out.inUse).toEqual([E(2), 'factory:claimed-by:h-2']);
    expect(out.remaining).toBe(0);
  });

  it('skips the issue read when there are no lease labels', async () => {
    const { client } = sweepClient(['bug'], []);
    const out = await sweepOrphanClaimLabels({ client, owner: 'o', repo: 'r' });
    expect(out.ran).toBe(true);
    expect(client.listAllOpenIssues).not.toHaveBeenCalled();
  });

  it('respects maxDeletes and reports the remainder', async () => {
    const { client, deleted } = sweepClient([E(1), E(2), E(3), E(4), E(5)], []);
    const out = await sweepOrphanClaimLabels({ client, owner: 'o', repo: 'r', maxDeletes: 2 });
    expect(deleted).toHaveLength(2);
    expect(out.remaining).toBe(3);
  });

  it('records a failing delete and continues', async () => {
    const { client, deleted } = sweepClient([E(1), E(2)], [], [E(1)]);
    const out = await sweepOrphanClaimLabels({ client, owner: 'o', repo: 'r' });
    expect(deleted).toEqual([E(2)]);
    expect(out.failed).toEqual([{ name: E(1), detail: `boom ${E(1)}` }]);
  });

  it('rejects without deleting when the open-issue listing fails', async () => {
    const { client, deleted } = sweepClient([E(1)], []);
    client.listAllOpenIssues = async () => {
      throw new Error('truncated');
    };
    await expect(sweepOrphanClaimLabels({ client, owner: 'o', repo: 'r' })).rejects.toThrow('truncated');
    expect(deleted).toEqual([]);
  });
});
