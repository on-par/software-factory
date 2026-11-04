// packages/core/src/queue/linear-queue-lifecycle.test.ts — Linear queue release, park, heartbeat and reap (#3893).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LinearTrackerSchema } from '../config/tracker-section.js';
import { LinearApiError } from '../work/linear-client.js';
import { toWorkKey } from '../work/work-key.js';
import { DEFAULT_CLAIM_LEASE_MS } from './github-queue.js';
import {
  createLinearQueueLifecycle,
  parseLinearClaimLease,
  type LinearClaimedIssue,
  type LinearClaimLease,
  type LinearQueueLifecycleClient,
} from './linear-queue-lifecycle.js';

interface Fixture {
  issue: LinearClaimedIssue & { state: string };
  comments: string[];
  teamLabels: { id: string; name: string }[];
}

const fixture = (): Fixture =>
  JSON.parse(
    readFileSync(new URL('./__fixtures__/linear-queue-lifecycle-on-12.json', import.meta.url), 'utf8'),
  ) as Fixture;

const WRITES = new Set([
  'addLabel',
  'removeLabel',
  'moveToState',
  'addComment',
  'upsertLeaseAttachment',
  'deleteAttachment',
]);

function fakeClient(fx: Fixture, opts: { failOn?: Set<string>; failReads?: boolean } = {}) {
  const failOn = opts.failOn ?? new Set<string>();
  const calls: string[] = [];
  const run = <T>(name: string, fn: () => T): Promise<T> => {
    calls.push(name);
    return failOn.has(name) ? Promise.reject(new LinearApiError('boom')) : Promise.resolve(fn());
  };
  const client: LinearQueueLifecycleClient = {
    findIssue: (id) => run('findIssue', () => (id === fx.issue.identifier ? fx.issue : null)),
    listLeasedIssues: () => run('listLeasedIssues', () => (fx.issue.lease ? [fx.issue] : [])),
    ensureLabel: (name) => run('ensureLabel', () => fx.teamLabels.find((l) => l.name === name)?.id ?? `lbl-${name}`),
    addLabel: (_id, labelId) =>
      run('addLabel', () => {
        const name = fx.teamLabels.find((l) => l.id === labelId)?.name ?? labelId;
        fx.issue.labels.push({ id: labelId, name });
      }),
    removeLabel: (_id, labelId) =>
      run('removeLabel', () => {
        fx.issue.labels = fx.issue.labels.filter((l) => l.id !== labelId);
      }),
    moveToState: (_id, state) =>
      run('moveToState', () => {
        fx.issue.state = state;
      }),
    addComment: (_id, body) => run('addComment', () => void fx.comments.push(body)),
    upsertLeaseAttachment: (_id, lease: LinearClaimLease) =>
      run('upsertLeaseAttachment', () => {
        fx.issue.lease = { attachmentId: 'att-new', metadata: lease };
      }),
    deleteAttachment: () =>
      run('deleteAttachment', () => {
        delete fx.issue.lease;
      }),
  };
  return { client, calls };
}

const linear = LinearTrackerSchema.parse({ teamKey: 'ON' });
const key = toWorkKey('ON-12');

function setup(o: { failOn?: Set<string>; claimantId?: string; now?: number; mutate?: (fx: Fixture) => void } = {}) {
  const fx = fixture();
  o.mutate?.(fx);
  const { client, calls } = fakeClient(fx, { failOn: o.failOn });
  const warn = vi.fn();
  const lifecycle = createLinearQueueLifecycle({
    client,
    linear,
    warn,
    claimantId: o.claimantId ?? 'host-a-1',
    now: () => o.now ?? 1700000000000,
  });
  const names = () => fx.issue.labels.map((l) => l.name);
  const writes = () => calls.filter((c) => WRITES.has(c));
  return { fx, lifecycle, warn, names, writes };
}

describe('release', () => {
  it('park adds the parked label, comments the reason and moves ON-12 to the ready state', async () => {
    const { fx, lifecycle, warn, names } = setup();
    await lifecycle.release(key, 'parked', 'CHECK failed after 3 rework rounds');
    expect(names()).toContain('factory:parked');
    expect(names()).not.toContain('factory:claimed-by:host-a-1');
    expect(fx.comments[0]).toContain('CHECK failed after 3 rework rounds');
    expect(fx.issue.state).toBe('Todo');
    expect(fx.issue.lease).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('queued release removes the claim label and lease and moves ON-12 to ready', async () => {
    const { fx, lifecycle, names } = setup();
    await lifecycle.release(key);
    expect(names()).not.toContain('factory:claimed-by:host-a-1');
    expect(fx.issue.lease).toBeUndefined();
    expect(fx.issue.state).toBe('Todo');
    expect(names()).not.toContain('factory:parked');
    expect(fx.comments).toEqual([]);
  });

  it('done release leaves the state In Progress', async () => {
    const { fx, lifecycle, names } = setup();
    await lifecycle.release(key, 'done');
    expect(names()).not.toContain('factory:claimed-by:host-a-1');
    expect(fx.issue.state).toBe('In Progress');
  });

  it('park with no reason says so', async () => {
    const { fx, lifecycle } = setup();
    await lifecycle.release(key, 'parked');
    expect(fx.comments[0]).toContain('(no reason given)');
  });

  it('release by a non-holder changes nothing', async () => {
    const { fx, lifecycle, writes } = setup({ claimantId: 'host-b-2' });
    await lifecycle.release(key, 'parked', 'x');
    expect(writes()).toEqual([]);
    expect(fx.issue.lease).toBeDefined();
    expect(fx.issue.state).toBe('In Progress');
  });

  it('release of an unknown key warns', async () => {
    const { lifecycle, warn } = setup();
    await lifecycle.release(toWorkKey('ON-99'));
    expect(warn).toHaveBeenCalledWith('linear queue: release of ON-99: issue not found');
  });

  it('a failed lookup during release warns and resolves', async () => {
    const { lifecycle, warn } = setup({ failOn: new Set(['findIssue']) });
    await expect(lifecycle.release(key)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a failed write during release warns and resolves', async () => {
    const { fx, lifecycle, warn, names } = setup({ failOn: new Set(['addComment']) });
    await expect(lifecycle.release(key, 'parked', 'why')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ON-12'));
    expect(names()).toContain('factory:parked');
    expect(fx.issue.state).toBe('Todo');
  });
});

describe('heartbeat', () => {
  it('heartbeat writes the lease into the factory attachment metadata', async () => {
    const { fx, lifecycle } = setup({ mutate: (f) => void delete f.issue.lease });
    await expect(lifecycle.heartbeat(key)).resolves.toBe(true);
    expect(fx.issue.lease?.metadata).toEqual({
      kind: 'factory-claim-lease',
      claimantId: 'host-a-1',
      expiresAt: 1700000000000 + DEFAULT_CLAIM_LEASE_MS,
    });
  });

  it('returns false when the claim label is gone', async () => {
    const { lifecycle } = setup({
      mutate: (f) => void (f.issue.labels = f.issue.labels.filter((l) => !l.name.includes('claimed-by'))),
    });
    await expect(lifecycle.heartbeat(key)).resolves.toBe(false);
  });

  it('returns false for an unknown issue', async () => {
    const { lifecycle } = setup();
    await expect(lifecycle.heartbeat(toWorkKey('ON-99'))).resolves.toBe(false);
  });

  it('warns and returns true when the lookup rejects', async () => {
    const { lifecycle, warn } = setup({ failOn: new Set(['findIssue']) });
    await expect(lifecycle.heartbeat(key)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns and returns true when the lease write fails', async () => {
    const { lifecycle, warn } = setup({ failOn: new Set(['upsertLeaseAttachment']) });
    await expect(lifecycle.heartbeat(key)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lease renew'));
  });
});

describe('reap', () => {
  it('reap frees ON-12 when its attachment lease has expired', async () => {
    const { fx, lifecycle, names } = setup({ now: 1700000900001 });
    const rows = await lifecycle.reap();
    expect(rows).toEqual([
      expect.objectContaining({ key: 'ON-12', outcome: 'released', released: true, claimantId: 'host-a-1' }),
    ]);
    expect(names()).not.toContain('factory:claimed-by:host-a-1');
    expect(fx.issue.lease).toBeUndefined();
    expect(fx.issue.state).toBe('Todo');
    expect(names()).toContain('factory:ready');
  });

  it('reap keeps ON-12 claimed while its lease is live', async () => {
    const { fx, lifecycle, names, writes } = setup({ now: 1700000000000 });
    await expect(lifecycle.reap()).resolves.toEqual([]);
    expect(names()).toContain('factory:claimed-by:host-a-1');
    expect(fx.issue.lease).toBeDefined();
    expect(fx.issue.state).toBe('In Progress');
    expect(writes()).toEqual([]);
  });

  it('reap reads the lease from the factory attachment metadata and skips malformed metadata', async () => {
    const { lifecycle, warn, writes } = setup({
      now: 1700000900001,
      mutate: (f) => void (f.issue.lease = { attachmentId: 'att-lease-12', metadata: { kind: 'other' } }),
    });
    await expect(lifecycle.reap()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
  });

  it('a failed write during reap warns and reports a failed row', async () => {
    const { lifecycle, warn } = setup({ now: 1700000900001, failOn: new Set(['removeLabel']) });
    const rows = await lifecycle.reap();
    expect(rows).toEqual([expect.objectContaining({ outcome: 'failed', released: false, detail: 'boom' })]);
    expect(warn).toHaveBeenCalled();
  });

  it('warns and returns [] when listing rejects', async () => {
    const { lifecycle, warn } = setup({ failOn: new Set(['listLeasedIssues']) });
    await expect(lifecycle.reap()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('parseLinearClaimLease', () => {
  const valid = { kind: 'factory-claim-lease', claimantId: 'c', expiresAt: 5 };
  it.each([
    ['null', null, null],
    ['a string', 'x', null],
    ['missing claimantId', { kind: 'factory-claim-lease', expiresAt: 5 }, null],
    ['missing expiresAt', { kind: 'factory-claim-lease', claimantId: 'c' }, null],
    ['wrong kind', { ...valid, kind: 'other' }, null],
    ['valid', valid, valid],
  ])('%s', (_name, input, expected) => {
    expect(parseLinearClaimLease(input)).toEqual(expected);
  });
});
