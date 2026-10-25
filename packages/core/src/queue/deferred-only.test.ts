// packages/core/src/queue/deferred-only.test.ts — Unqueue a queue that is only waiting on open prerequisites (#3660).

import { describe, expect, it, vi } from 'vitest';

import { unqueueDeferredOnly } from './deferred-only.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { IN_PROGRESS_LABEL, laneLabel, QUEUED_LABEL, type QueueGitHubClient, type QueueIssue } from './github-queue.js';

function fakeStore(issues: Array<{ number: number; labels: string[] }>) {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const removeLabel = vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
    state.get(issue_number)?.delete(name);
  });
  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      const out: QueueIssue[] = [];
      for (const [number, set] of state) {
        if (labels.every((l) => set.has(l))) out.push({ number, labels: [...set] });
      }
      return out;
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? [])];
    },
    async addLabels() {},
    removeLabel,
    ...fakeIssueComments(),
    async ensureLabel() {
      return false;
    },
  };
  return { state, client, removeLabel };
}

const queued = (n: number, lane = 'app') => ({
  number: n,
  labels: [QUEUED_LABEL, laneLabel(lane), `factory:order:${n}`],
});
const base = { owner: 'o', repo: 'r', lanes: ['app'] };

describe('unqueueDeferredOnly', () => {
  it('removes factory:queued from every deferred issue and keeps lane and order labels', async () => {
    const { client, state } = fakeStore([queued(2), queued(1)]);
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1, 2]) });
    expect(res).toEqual({ verdict: 'deferred-only', queued: [1, 2], unqueued: [1, 2], skipped: [] });
    expect([...state.get(1)!].sort()).toEqual([laneLabel('app'), 'factory:order:1']);
  });

  it('writes nothing when one queued issue was not deferred', async () => {
    const { client, removeLabel } = fakeStore([queued(1), queued(2)]);
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1]) });
    expect(res.verdict).toBe('mixed');
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('is empty when nothing is queued', async () => {
    const { client } = fakeStore([]);
    expect((await unqueueDeferredOnly({ ...base, client, deferred: new Set() })).verdict).toBe('empty');
  });

  it('ignores queued issues in unplanned lanes and claimed ones', async () => {
    const claimed = { number: 3, labels: [...queued(3).labels, IN_PROGRESS_LABEL] };
    const { client } = fakeStore([queued(1), queued(2, 'other'), claimed]);
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1]) });
    expect(res).toMatchObject({ verdict: 'deferred-only', queued: [1], unqueued: [1] });
  });

  it('skips an issue claimed between the list and the fresh read', async () => {
    const { client, state, removeLabel } = fakeStore([queued(1), queued(2)]);
    const real = client.getIssueLabels;
    client.getIssueLabels = async (input) => {
      if (input.issue_number === 1) state.get(1)!.add(IN_PROGRESS_LABEL);
      return real(input);
    };
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1, 2]) });
    expect(res.skipped).toEqual([{ issue: 1, reason: 'claimed' }]);
    expect(res.unqueued).toEqual([2]);
    expect(removeLabel).toHaveBeenCalledTimes(1);
  });

  it('skips an issue that lost factory:queued', async () => {
    const { client, state } = fakeStore([queued(1)]);
    const real = client.getIssueLabels;
    client.getIssueLabels = async (input) => {
      state.get(1)!.delete(QUEUED_LABEL);
      return real(input);
    };
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1]) });
    expect(res.skipped).toEqual([{ issue: 1, reason: 'no longer queued' }]);
  });

  it('records a removeLabel failure and keeps processing the rest', async () => {
    const { client, removeLabel } = fakeStore([queued(1), queued(2)]);
    removeLabel.mockRejectedValueOnce(new Error('403'));
    const res = await unqueueDeferredOnly({ ...base, client, deferred: new Set([1, 2]) });
    expect(res.skipped).toEqual([{ issue: 1, reason: '403' }]);
    expect(res.unqueued).toEqual([2]);
  });
});
