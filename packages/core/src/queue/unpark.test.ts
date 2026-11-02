import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import type { QueueGitHubClient } from './github-queue.js';
import { runUnpark, UnparkError } from './unpark.js';
import { readWorktreeKeeps, upsertWorktreeKeep } from '../worktree/worktree-keeps.js';
import { fakeIssueComments } from './fake-issue-comments.js';

function fakeClient(labels: Map<number, string[]>) {
  const addLabels = vi.fn(async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
    const have = labels.get(issue_number) ?? [];
    labels.set(issue_number, [...have, ...add.filter((l) => !have.includes(l))]);
  });
  const removeLabel = vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
    labels.set(
      issue_number,
      (labels.get(issue_number) ?? []).filter((l) => l !== name),
    );
  });
  const client: QueueGitHubClient = {
    listOpenIssuesWithLabels: async ({ labels: want }) =>
      [...labels.entries()]
        .filter(([, have]) => want.every((w) => have.includes(w)))
        .map(([number, have]) => ({ number, labels: [...have] })),
    getIssueLabels: async ({ issue_number }) => [...(labels.get(issue_number) ?? [])],
    addLabels,
    removeLabel,
    ...fakeIssueComments(),
    ensureLabel: async () => false,
  };
  return { client, addLabels, removeLabel };
}

const base = { owner: 'o', repo: 'r' };
const peers = (): [number, string[]][] => [
  [1, ['factory:queued', 'factory:lane:ops', 'factory:order:1']],
  [2, ['factory:queued', 'factory:lane:ops', 'factory:order:2']],
];

describe('runUnpark', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  it('re-queues a parked issue at lane max + 1 and removes factory:parked', async () => {
    const labels = new Map([...peers(), [42, ['bug', 'factory:parked', 'factory:lane:ops']] as [number, string[]]]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    expect(res.order).toBe(3);
    expect(res.lane).toBe('ops');
    expect(res.labelsAfter).toContain('factory:queued');
    expect(res.labelsAfter).toContain('factory:lane:ops');
    expect(res.labelsAfter).not.toContain('factory:parked');
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:order:'))).toEqual(['factory:order:3']);
  });

  it('replaces a stale order label with exactly one fresh one', async () => {
    const labels = new Map([
      ...peers(),
      [42, ['factory:parked', 'factory:lane:ops', 'factory:order:7']] as [number, string[]],
    ]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:order:'))).toEqual(['factory:order:3']);
  });

  it('rejects an issue that is not parked without writing', async () => {
    const { client, addLabels, removeLabel } = fakeClient(new Map([[5, ['factory:lane:ops']]]));
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'not-parked' });
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('requires --lane when there are zero or several lane labels', async () => {
    const zero = fakeClient(new Map([[5, ['factory:parked']]]));
    await expect(runUnpark({ ...base, client: zero.client, issue: 5 })).rejects.toMatchObject({
      code: 'lane-required',
    });
    expect(zero.removeLabel).not.toHaveBeenCalled();
    const two = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:a', 'factory:lane:b']]]));
    const err = await runUnpark({ ...base, client: two.client, issue: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnparkError);
    expect((err as UnparkError).code).toBe('lane-required');
    expect((err as UnparkError).message).toContain('a, b');
    expect(two.addLabels).not.toHaveBeenCalled();
    expect(two.removeLabel).not.toHaveBeenCalled();
  });

  it('--lane overrides and removes other lane labels', async () => {
    const { client } = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:ops']]]));
    const res = await runUnpark({ ...base, client, issue: 5, lane: 'daw' });
    expect(res.lane).toBe('daw');
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:lane:'))).toEqual(['factory:lane:daw']);
  });

  it('assigns a position after an order-only in-lane issue', async () => {
    const labels = new Map([
      [5, ['factory:parked', 'factory:lane:ops']],
      [24, ['factory:lane:ops', 'factory:order:24']],
    ]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 5 });
    expect(res.order).toBe(25);
  });

  it('reports the order-only issue holding the slot a queued-only scan would reuse', async () => {
    const labels = new Map<number, string[]>([
      [5, ['factory:parked', 'factory:lane:ops']],
      [23, ['factory:queued', 'factory:lane:ops', 'factory:order:23']],
      [24, ['factory:lane:ops', 'factory:order:24']],
    ]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 5 });
    expect(res.order).toBe(25);
    expect(res.collision).toEqual({ order: 24, heldBy: [24] });
  });

  it('has no collision key without an order-only holder', async () => {
    const labels = new Map<number, string[]>([[5, ['factory:parked', 'factory:lane:ops']], ...peers()]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 5 });
    expect(res).not.toHaveProperty('collision');
  });

  it("removes the issue's keep record once the issue is re-queued", async () => {
    const keepsFile = join(tmp.makeSync('unpark-keeps-'), 'worktree-keeps.json');
    upsertWorktreeKeep(keepsFile, { issue: 5, path: '/wt', reason: 'manual', since: 'now' });
    upsertWorktreeKeep(keepsFile, { issue: 6, path: '/wt6', reason: 'manual', since: 'now' });
    const { client } = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:ops']], ...peers()]));
    await runUnpark({ ...base, client, issue: 5, keepsFile });
    expect(readWorktreeKeeps(keepsFile).map((k) => k.issue)).toEqual([6]);
  });

  it('warns, and still succeeds, when the keep record cannot be released', async () => {
    const dir = tmp.makeSync('unpark-keeps-');
    const keepsFile = join(dir, 'worktree-keeps.json');
    upsertWorktreeKeep(keepsFile, { issue: 5, path: '/wt', reason: 'manual', since: 'now' });
    const { client } = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:ops']], ...peers()]));
    const warn = vi.fn();
    chmodSync(dir, 0o500);
    try {
      const res = await runUnpark({ ...base, client, issue: 5, keepsFile, warn });
      expect(res.ok).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not release the keep record for #5'));
  });

  it('leaves the keep record when the unpark fails', async () => {
    const keepsFile = join(tmp.makeSync('unpark-keeps-'), 'worktree-keeps.json');
    upsertWorktreeKeep(keepsFile, { issue: 5, path: '/wt', reason: 'manual', since: 'now' });
    const { client } = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:ops']]]));
    client.addLabels = async () => {
      throw new Error('api down');
    };
    await expect(runUnpark({ ...base, client, issue: 5, keepsFile })).rejects.toMatchObject({ code: 'unpark-failed' });
    expect(readWorktreeKeeps(keepsFile)).toHaveLength(1);
  });

  it('keeps factory:parked when enqueue fails so a retry is possible', async () => {
    const labels = new Map([[5, ['factory:parked', 'factory:lane:ops']]]);
    const { client } = fakeClient(labels);
    client.addLabels = async () => {
      throw new Error('api down');
    };
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'unpark-failed' });
    expect(labels.get(5)).toContain('factory:parked');
  });

  it('wraps a failing initial label read as unpark-failed', async () => {
    const { client } = fakeClient(new Map());
    client.getIssueLabels = async () => {
      throw new Error('read down');
    };
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'unpark-failed' });
  });

  it('matches the golden fixture', async () => {
    const labels = new Map([...peers(), [42, ['bug', 'factory:parked', 'factory:lane:ops']] as [number, string[]]]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    const golden = JSON.parse(readFileSync(new URL('./__fixtures__/unpark.json', import.meta.url), 'utf-8'));
    expect(res).toEqual(golden);
  });

  describe('lane placement and --keep-order (#3554)', () => {
    /** Lane `bugfix` with #101..#117 at orders 1..17 (#101 in progress, no queued label); the rest queued. */
    const lane17 = (skip: number[] = []): Map<number, string[]> => {
      const m = new Map<number, string[]>();
      for (let i = 1; i <= 17; i++) {
        if (skip.includes(i)) continue;
        m.set(
          100 + i,
          i === 1
            ? ['factory:in-progress', 'factory:lane:bugfix', 'factory:order:1']
            : ['factory:queued', 'factory:lane:bugfix', `factory:order:${i}`],
        );
      }
      return m;
    };
    const parked = (n: number): [number, string[]] => [n, ['factory:parked', 'factory:lane:bugfix']];
    const orderLabels = (l: string[] | undefined) => (l ?? []).filter((x) => x.startsWith('factory:order:'));

    it('queues at the back after an in-progress claim', async () => {
      const labels = lane17();
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const res = await runUnpark({ ...base, client, issue: 200 });
      expect(res.order).toBe(18);
      expect(orderLabels(labels.get(200))).toEqual(['factory:order:18']);
      const holders18 = [...labels].filter(([n, l]) => n !== 200 && l.includes('factory:order:18'));
      expect(holders18).toEqual([]);
    });

    it('fails closed when the lane scan omits the parked issue', async () => {
      const labels = new Map([parked(200)]);
      const { client, addLabels } = fakeClient(labels);
      client.listOpenIssuesWithLabels = async () => [];
      await expect(runUnpark({ ...base, client, issue: 200 })).rejects.toMatchObject({ code: 'unpark-failed' });
      expect(labels.get(200)).toContain('factory:parked');
      expect(orderLabels(labels.get(200))).toEqual([]);
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('fails closed when the lane listing throws', async () => {
      const labels = new Map([parked(200)]);
      const { client, addLabels } = fakeClient(labels);
      client.listOpenIssuesWithLabels = async () => {
        throw new Error('listing down');
      };
      await expect(runUnpark({ ...base, client, issue: 200 })).rejects.toMatchObject({ code: 'unpark-failed' });
      expect(labels.get(200)).toContain('factory:parked');
      expect(orderLabels(labels.get(200))).toEqual([]);
      expect(addLabels).not.toHaveBeenCalled();
    });

    it("keeps today's placement for --lane into another lane (issue is not a member)", async () => {
      const labels = lane17();
      labels.set(200, ['factory:parked', 'factory:lane:other']);
      const { client } = fakeClient(labels);
      const res = await runUnpark({ ...base, client, issue: 200, lane: 'bugfix' });
      expect(res.order).toBe(18);
    });

    it('keepOrder restores a free park-time order', async () => {
      const labels = lane17([5]);
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const warn = vi.fn();
      const res = await runUnpark({
        ...base,
        client,
        issue: 200,
        keepOrder: true,
        readParkedOrder: async () => 5,
        warn,
      });
      expect(res.order).toBe(5);
      expect(orderLabels(labels.get(200))).toEqual(['factory:order:5']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keepOrder goes to the back and names the holder when the order is taken', async () => {
      const labels = lane17();
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const warn = vi.fn();
      const res = await runUnpark({
        ...base,
        client,
        issue: 200,
        keepOrder: true,
        readParkedOrder: async () => 5,
        warn,
      });
      expect(res.order).toBe(18);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('#105'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('order 18'));
    });

    it('keepOrder with no recorded order warns and goes to the back', async () => {
      const labels = lane17();
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const warn = vi.fn();
      const res = await runUnpark({
        ...base,
        client,
        issue: 200,
        keepOrder: true,
        readParkedOrder: async () => undefined,
        warn,
      });
      expect(res.order).toBe(18);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no recorded park-time order'));
    });

    it('keepOrder when the reader throws warns and goes to the back', async () => {
      const labels = lane17();
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const warn = vi.fn();
      const res = await runUnpark({
        ...base,
        client,
        issue: 200,
        keepOrder: true,
        readParkedOrder: async () => {
          throw new Error('comments down');
        },
        warn,
      });
      expect(res.order).toBe(18);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('comments down'));
    });

    it('ignores the recorded park order without keepOrder', async () => {
      const labels = lane17([5]);
      labels.set(...parked(200));
      const { client } = fakeClient(labels);
      const readParkedOrder = vi.fn(async () => 5);
      const res = await runUnpark({ ...base, client, issue: 200, readParkedOrder });
      expect(res.order).toBe(18);
      expect(readParkedOrder).not.toHaveBeenCalled();
    });
  });
});

describe('runUnpark pagination', () => {
  it('#3123 unpark after queueing 1..N across more than one page places the issue at N+1', async () => {
    const N = 120;
    const labels = new Map<number, string[]>(
      Array.from({ length: N }, (_, i): [number, string[]] => [
        i + 1,
        ['factory:queued', 'factory:lane:ops', `factory:order:${i + 1}`],
      ]),
    );
    labels.set(500, ['factory:parked', 'factory:lane:ops']);
    const { client: inner } = fakeClient(labels);
    // Serve the lane in pages of 100, as GitHub does, and combine them the way octokit.paginate does.
    const client: QueueGitHubClient = {
      ...inner,
      listOpenIssuesWithLabels: async (input) => {
        const all = await inner.listOpenIssuesWithLabels(input);
        const pages = [all.slice(0, 100), all.slice(100)];
        return pages.flat();
      },
    };
    const res = await runUnpark({ ...base, client, issue: 500 });
    expect(res.order).toBe(N + 1);
  });
});
