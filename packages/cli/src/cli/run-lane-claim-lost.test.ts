// packages/cli/src/cli/run-lane-claim-lost.test.ts — a lost or lapsed claim lease stops the run before push/PR/merge (#3146)

import { describe, expect, it, vi } from 'vitest';

import { runLane } from './run-lane.js';

const TICK = 5 * 60 * 1000;
const LEASE = 15 * 60 * 1000;
const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

type Emitted = { kind: string; issue: unknown; msg: string; extra: any };

function harness() {
  const events: Emitted[] = [];
  const calls: string[] = [];
  const emitEvent: any = (_file: string, kind: string, issue: unknown, msg: string, extra: any) => {
    events.push({ kind, issue, msg, extra });
  };
  const base = {
    emitEvent,
    pathExists: () => false,
    hostId: 'host-a',
    runId: 'run-1',
    leaseMs: LEASE,
    now: () => new Date(Date.now()),
    waitMerge: async () => {
      calls.push('waitMerge');
    },
    releaseIssue: async (issue: number, outcome: string) => {
      calls.push(`release:${issue}:${outcome}`);
    },
    reapWorktree: async () => {
      calls.push('reap');
    },
    closeParkedPr: async () => {
      calls.push('closePr');
    },
  };
  return { events, calls, base };
}

/** A BUILD gate then a ship that mirrors core: refuse to push/open a PR once the signal is aborted. */
function gatedShip(calls: string[]) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const ship = async (issue: number, _o: unknown, ctx?: { signal?: AbortSignal }): Promise<string> => {
    if (issue !== 1) return 'b';
    await gate;
    ctx?.signal?.throwIfAborted();
    calls.push('push');
    calls.push('createPr');
    return 'b';
  };
  return { ship, open };
}

describe('runLane claim loss (#3146)', () => {
  it('heartbeat false mid-BUILD aborts before SHIP, emits claim_lost, makes no push/PR call and does not release (#3146)', async () => {
    vi.useFakeTimers();
    try {
      const { events, calls, base } = harness();
      const { ship, open } = gatedShip(calls);
      const run = runLane('app', [1, 2], '/repo', 'o/r', paths, { ...base, ship, heartbeat: async () => false });
      await vi.advanceTimersByTimeAsync(TICK);
      open();
      await vi.advanceTimersByTimeAsync(0);
      await run;

      expect(calls).not.toContain('push');
      expect(calls).not.toContain('createPr');
      expect(calls).not.toContain('reap');
      expect(calls).not.toContain('closePr');
      expect(calls.filter((c) => c.startsWith('release:1:'))).toEqual([]);
      const lost = events.filter((e) => e.kind === 'claim_lost');
      expect(lost).toHaveLength(1);
      expect(lost[0].extra.claimLost).toEqual({ hostId: 'host-a', issue: 1, runId: 'run-1', kind: 'released' });
      expect(events.some((e) => e.kind === 'parked')).toBe(false);
      // The lane moved on to the second issue and finished.
      expect(calls).toContain('release:2:done');
      expect(events.some((e) => e.kind === 'lane-done')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat throwing past the lease logs lease_renew_failed once per failure and stops with claim_lost (#3146)', async () => {
    vi.useFakeTimers();
    try {
      const { events, calls, base } = harness();
      const { ship, open } = gatedShip(calls);
      const run = runLane('app', [1], '/repo', 'o/r', paths, {
        ...base,
        ship,
        heartbeat: async () => {
          throw new Error('github down');
        },
      });
      await vi.advanceTimersByTimeAsync(LEASE);
      open();
      await vi.advanceTimersByTimeAsync(0);
      await run;

      const renew = events.filter((e) => e.kind === 'lease_renew_failed');
      expect(renew.map((e) => /\((\d+) consecutive\)/.exec(e.msg)?.[1])).toEqual(['1', '2', '3']);
      const lost = events.filter((e) => e.kind === 'claim_lost');
      expect(lost).toHaveLength(1);
      expect(lost[0].extra.claimLost).toMatchObject({ issue: 1, kind: 'lapsed' });
      expect(events.indexOf(lost[0])).toBeGreaterThan(events.indexOf(renew[2]));
      expect(calls).not.toContain('push');
      expect(calls.some((c) => c.startsWith('release:'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('succeeding heartbeats leave the signal un-aborted and ship, merge and release done as before (#3146)', async () => {
    vi.useFakeTimers();
    try {
      const { events, calls, base } = harness();
      const signals: AbortSignal[] = [];
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const run = runLane('app', [1], '/repo', 'o/r', paths, {
        ...base,
        ship: async (_i, _o, ctx) => {
          if (ctx?.signal) signals.push(ctx.signal);
          await gate;
          calls.push('push');
          return 'b';
        },
        heartbeat: async () => true,
      });
      await vi.advanceTimersByTimeAsync(LEASE);
      open();
      await vi.advanceTimersByTimeAsync(0);
      await run;

      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
      expect(calls).toEqual(['push', 'waitMerge', 'release:1:done']);
      expect(events.some((e) => e.kind === 'claim_lost' || e.kind === 'lease_renew_failed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
