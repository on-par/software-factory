// packages/cli/src/cli/lane-heartbeat.test.ts — claim lease tracking and withHeartbeat abort (#3146)

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimLostError, createClaimLease, withHeartbeat } from './lane-heartbeat.js';

const LEASE = 15 * 60 * 1000;
const TICK = 5 * 60 * 1000;

function leaseAt(clock: { t: number }, onRenewFailed = vi.fn()) {
  return { lease: createClaimLease(7, { leaseMs: LEASE, now: () => clock.t, onRenewFailed }), onRenewFailed };
}

describe('createClaimLease', () => {
  it('a false result aborts the signal with ClaimLostError(released)', () => {
    const { lease } = leaseAt({ t: 0 });
    lease.renewed(false);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.lost).toBeInstanceOf(ClaimLostError);
    expect(lease.lost?.kind).toBe('released');
    expect(lease.signal.reason).toBe(lease.lost);
  });

  it.each([true, undefined, 'ok'])('%s counts as renewed', (result) => {
    const { lease } = leaseAt({ t: 0 });
    lease.renewed(result);
    expect(lease.signal.aborted).toBe(false);
    expect(lease.lost).toBeUndefined();
  });

  it('a failure before expiry is reported with a count, and a success resets it', () => {
    const clock = { t: 0 };
    const { lease, onRenewFailed } = leaseAt(clock);
    clock.t = TICK;
    lease.renewFailed('x');
    clock.t = 2 * TICK;
    lease.renewFailed('y');
    expect(onRenewFailed.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(lease.lost).toBeUndefined();
    lease.renewed(true);
    lease.renewFailed('z');
    expect(onRenewFailed.mock.calls.at(-1)?.[0]).toBe(1);
  });

  it('a success extends the confirmed expiry', () => {
    const clock = { t: 0 };
    const { lease } = leaseAt(clock);
    clock.t = TICK;
    lease.renewed(true);
    clock.t = LEASE;
    lease.renewFailed('x');
    expect(lease.lost).toBeUndefined();
  });

  it('a failure at the confirmed expiry loses the lease as lapsed, then stops logging', () => {
    const clock = { t: 0 };
    const { lease, onRenewFailed } = leaseAt(clock);
    clock.t = LEASE;
    lease.renewFailed('x');
    expect(lease.lost?.kind).toBe('lapsed');
    expect(lease.signal.aborted).toBe(true);
    lease.renewFailed('again');
    expect(onRenewFailed).toHaveBeenCalledTimes(1);
  });
});

describe('withHeartbeat with a lease', () => {
  afterEach(() => vi.useRealTimers());

  it('throws without running work when the lease is already lost', async () => {
    const { lease } = leaseAt({ t: 0 });
    lease.renewed(false);
    const work = vi.fn(async () => 1);
    await expect(withHeartbeat(7, async () => true, work, lease)).rejects.toBeInstanceOf(ClaimLostError);
    expect(work).not.toHaveBeenCalled();
  });

  it('hands work a never-aborted signal when there is no heartbeat', async () => {
    const seen: AbortSignal[] = [];
    await withHeartbeat(7, undefined, async (s) => void seen.push(s));
    expect(seen[0].aborted).toBe(false);
  });

  it('a false heartbeat aborts work and a work rejection becomes ClaimLostError', async () => {
    vi.useFakeTimers();
    const { lease } = leaseAt({ t: 0 });
    const run = withHeartbeat(
      7,
      async () => false,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      lease,
    );
    const assertion = expect(run).rejects.toBeInstanceOf(ClaimLostError);
    await vi.advanceTimersByTimeAsync(TICK);
    await assertion;
  });

  it('an unrelated rejection with a healthy lease passes through', async () => {
    const { lease } = leaseAt({ t: 0 });
    await expect(
      withHeartbeat(
        7,
        async () => true,
        async () => Promise.reject(new Error('boom')),
        lease,
      ),
    ).rejects.toThrow('boom');
  });
});
