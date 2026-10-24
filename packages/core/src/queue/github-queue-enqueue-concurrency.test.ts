// packages/core/src/queue/github-queue-enqueue-concurrency.test.ts — concurrent enqueue/unpark never leave duplicate or double order labels (#3147).

import { describe, expect, it, vi } from 'vitest';

import { createGithubQueue, type QueueGitHubClient } from './github-queue.js';
import type { OrderCollisionRepair } from './order-collision.js';
import { orderedCandidates } from './queue-order.js';
import { runUnpark } from './unpark.js';
import { fakeIssueComments } from './fake-issue-comments.js';

const base = { owner: 'o', repo: 'r' };
const ORDER = 'factory:order:';
const PREEMPTION_BOUND = 3;

type Store = Map<number, string[]>;

const notFound = (): Error => Object.assign(new Error('Not Found'), { status: 404 });

/** In-memory label store; each client method first waits for the scheduler to release its call. */
function gatedClient(store: Store, gate: () => Promise<void>): QueueGitHubClient {
  return {
    async listOpenIssuesWithLabels({ labels }) {
      await gate();
      return [...store.entries()]
        .filter(([, have]) => labels.every((l) => have.includes(l)))
        .map(([number, have]) => ({ number, labels: [...have] }));
    },
    async getIssueLabels({ issue_number }) {
      await gate();
      return [...(store.get(issue_number) ?? [])];
    },
    async addLabels({ issue_number, labels }) {
      await gate();
      const have = store.get(issue_number) ?? [];
      store.set(issue_number, [...have, ...labels.filter((l) => !have.includes(l))]);
    },
    async removeLabel({ issue_number, name }) {
      await gate();
      const have = store.get(issue_number) ?? [];
      if (!have.includes(name)) throw notFound();
      store.set(
        issue_number,
        have.filter((l) => l !== name),
      );
    },
    async ensureLabel() {
      await gate();
      return false;
    },
    ...fakeIssueComments(),
  };
}

interface Decision {
  chosen: number;
  lastOp: number | undefined;
  lastPending: boolean;
  preemptsBefore: number;
}

/** Runs `ops` against a fresh store, releasing one pending call at a time per `prefix`, then the default policy (stay on the last op). */
async function runSchedule<T>(
  seed: () => Store,
  ops: Array<(client: QueueGitHubClient, store: Store) => Promise<T>>,
  prefix: readonly number[],
): Promise<{ store: Store; trace: Decision[]; settled: Array<PromiseSettledResult<T>> }> {
  const store = seed();
  const pending: Array<(() => void) | undefined> = ops.map(() => undefined);
  const settledFlags = ops.map(() => false);
  const promises = ops.map((op, i) => {
    const client = gatedClient(store, () => new Promise<void>((resolve) => (pending[i] = resolve)));
    return op(client, store).finally(() => (settledFlags[i] = true));
  });
  const all = Promise.allSettled(promises);
  const trace: Decision[] = [];
  let lastOp: number | undefined;
  let preempts = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  while (!settledFlags.every(Boolean)) {
    await tick();
    const ready = pending.flatMap((p, i) => (p ? [i] : []));
    if (ready.length === 0) continue;
    let chosen = ready[0] ?? 0;
    if (ready.length > 1) {
      const lastPending = lastOp !== undefined && ready.includes(lastOp);
      const forced = prefix[trace.length];
      chosen = forced ?? (lastPending && lastOp !== undefined ? lastOp : (ready[0] ?? 0));
      trace.push({ chosen, lastOp, lastPending, preemptsBefore: preempts });
      if (lastPending && chosen !== lastOp) preempts += 1;
    }
    const release = pending[chosen];
    pending[chosen] = undefined;
    lastOp = chosen;
    release?.();
  }
  return { store, trace, settled: await all };
}

/** DFS over scheduling choices for two ops, bounded by preemptions so the tree stays enumerable. */
async function forEachSchedule<T>(
  seed: () => Store,
  ops: Array<(client: QueueGitHubClient, store: Store) => Promise<T>>,
  check: (store: Store, settled: Array<PromiseSettledResult<T>>) => void,
): Promise<number> {
  let runs = 0;
  async function explore(prefix: number[]): Promise<void> {
    const { store, trace, settled } = await runSchedule(seed, ops, prefix);
    runs += 1;
    check(store, settled);
    for (let i = prefix.length; i < trace.length; i += 1) {
      const d = trace[i];
      if (!d) continue;
      const alt = d.chosen === 0 ? 1 : 0;
      const cost = d.preemptsBefore + (d.lastPending && alt !== d.lastOp ? 1 : 0);
      if (cost <= PREEMPTION_BOUND) await explore([...trace.slice(0, i).map((x) => x.chosen), alt]);
    }
  }
  await explore([]);
  return runs;
}

const queuedMember = (n: number): [number, string[]] => [n, ['factory:queued', 'factory:lane:l', `${ORDER}${n}`]];
const orderLabels = (store: Store, n: number): string[] => (store.get(n) ?? []).filter((l) => l.startsWith(ORDER));

function laneMembers(store: Store) {
  return [...store.entries()]
    .filter(([, have]) => have.includes('factory:lane:l'))
    .map(([number, labels]) => ({ number, labels: [...labels] }));
}

describe('concurrent enqueue (#3147)', () => {
  it('two concurrent enqueuers in one lane end with unique positions under every interleaving', async () => {
    const seed = (): Store => new Map([queuedMember(1), queuedMember(2), queuedMember(3), [10, []], [11, []]]);
    const op = (n: number) => (client: QueueGitHubClient) => createGithubQueue({ client, ...base }).enqueue('l', [n]);
    const runs = await forEachSchedule(seed, [op(10), op(11)], (store, settled) => {
      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      const positions: number[] = [];
      for (const n of [1, 2, 3, 10, 11]) {
        const labels = orderLabels(store, n);
        expect(labels, `#${n} in ${JSON.stringify([...store])}`).toHaveLength(1);
        positions.push(Number((labels[0] ?? '').slice(ORDER.length)));
      }
      expect(new Set(positions).size).toBe(positions.length);
    });
    expect(runs).toBeGreaterThan(50);
  }, 120_000);

  it('two concurrent unparks of one issue leave exactly one order label and orderedCandidates does not throw', async () => {
    const seed = (): Store => new Map([queuedMember(1), [20, ['factory:parked', 'factory:lane:l', `${ORDER}7`]]]);
    const op = (client: QueueGitHubClient) => runUnpark({ ...base, client, issue: 20 });
    const runs = await forEachSchedule(seed, [op, op], (store, settled) => {
      expect(settled.filter((s) => s.status === 'rejected').length).toBeLessThanOrEqual(1);
      expect(orderLabels(store, 20)).toHaveLength(1);
      expect(() => orderedCandidates('l', laneMembers(store))).not.toThrow();
    });
    expect(runs).toBeGreaterThan(20);
  }, 120_000);
});

describe('enqueue write-then-verify', () => {
  const plain = (store: Store): QueueGitHubClient => gatedClient(store, async () => {});

  it('unpark right after queuing 1..N yields order N+1 (#3123)', async () => {
    const store: Store = new Map([1, 2, 3, 4, 5].map((n): [number, string[]] => [n, []]));
    const client = plain(store);
    const onOrderCollisionRepaired = vi.fn();
    const queue = createGithubQueue({ client, ...base, onOrderCollisionRepaired });
    await queue.enqueue('l', [1, 2, 3, 4, 5]);
    store.set(9, ['factory:parked', 'factory:lane:l']);
    const res = await runUnpark({ ...base, client, issue: 9, onOrderCollisionRepaired });
    expect(res.order).toBe(6);
    expect(onOrderCollisionRepaired).not.toHaveBeenCalled();
  });

  it('emits order_collision_repaired when a shared position is repaired', async () => {
    const store: Store = new Map([queuedMember(1), queuedMember(2), queuedMember(3), [10, []]]);
    const inner = plain(store);
    const client: QueueGitHubClient = {
      ...inner,
      // A concurrent host takes slot 4 after our scan and before our write.
      async getIssueLabels(input) {
        if (input.issue_number === 10 && !store.has(5)) store.set(5, ['factory:queued', 'factory:lane:l', `${ORDER}4`]);
        return inner.getIssueLabels(input);
      },
    };
    const repairs: OrderCollisionRepair[] = [];
    const [r] = await createGithubQueue({ client, ...base, onOrderCollisionRepaired: (x) => repairs.push(x) }).enqueue(
      'l',
      [10],
    );
    expect(repairs).toEqual([{ lane: 'l', position: 4, moved: 10, kept: 5, from: 4, to: 5, attempt: 1 }]);
    expect(r).toMatchObject({ issue: 10, outcome: 'queued', position: 5, repairs });
    expect(orderLabels(store, 10)).toEqual([`${ORDER}5`]);
    expect(orderLabels(store, 5)).toEqual([`${ORDER}4`]);
  });

  it('moves the other member when it has the higher issue number', async () => {
    const store: Store = new Map([queuedMember(1), [10, []]]);
    const inner = plain(store);
    const client: QueueGitHubClient = {
      ...inner,
      async getIssueLabels(input) {
        if (input.issue_number === 10 && !store.has(30))
          store.set(30, ['factory:queued', 'factory:lane:l', `${ORDER}2`]);
        return inner.getIssueLabels(input);
      },
    };
    const [r] = await createGithubQueue({ client, ...base }).enqueue('l', [10]);
    expect(r).toMatchObject({ outcome: 'queued', position: 2, repairs: [{ moved: 30, kept: 10, from: 2, to: 3 }] });
    expect(orderLabels(store, 30)).toEqual([`${ORDER}3`]);
  });

  it('dedupes an already-queued issue that carries several order labels', async () => {
    const store: Store = new Map([[10, ['factory:queued', 'factory:lane:l', `${ORDER}6`, `${ORDER}4`]]]);
    const [r] = await createGithubQueue({ client: plain(store), ...base }).enqueue('l', [10]);
    expect(r).toMatchObject({ outcome: 'already-queued', position: 4 });
    expect(orderLabels(store, 10)).toEqual([`${ORDER}4`]);
  });

  it('fails when the written order label vanished', async () => {
    const store: Store = new Map([[10, []]]);
    const inner = plain(store);
    const client: QueueGitHubClient = {
      ...inner,
      async addLabels(input) {
        await inner.addLabels(input);
        store.set(10, ['factory:queued', 'factory:lane:l']);
      },
    };
    const [r] = await createGithubQueue({ client, ...base }).enqueue('l', [10]);
    expect(r).toMatchObject({ outcome: 'failed', detail: 'order label vanished or malformed after write' });
  });

  it('stops after 3 repair attempts', async () => {
    const store: Store = new Map([queuedMember(1), [10, []]]);
    const inner = plain(store);
    const client: QueueGitHubClient = {
      ...inner,
      // A phantom member #99 always shares whatever slot #10 holds.
      async listOpenIssuesWithLabels(input) {
        const real = (await inner.listOpenIssuesWithLabels(input)).filter((m) => m.number !== 99);
        const mine = (store.get(10) ?? []).find((l) => l.startsWith(ORDER));
        const phantom = mine ? [{ number: 99, labels: ['factory:queued', 'factory:lane:l', mine] }] : [];
        return [...real, ...phantom];
      },
    };
    const onOrderCollisionRepaired = vi.fn();
    const [r] = await createGithubQueue({ client, ...base, onOrderCollisionRepaired }).enqueue('l', [10]);
    expect(r?.outcome).toBe('queued');
    expect(r?.repairs).toHaveLength(3);
    expect(onOrderCollisionRepaired).toHaveBeenCalledTimes(3);
  });
});
