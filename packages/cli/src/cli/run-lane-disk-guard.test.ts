// packages/cli/src/cli/run-lane-disk-guard.test.ts — runLane host disk guard (#2284)

import { describe, expect, it } from 'vitest';

import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
const hold = { kind: 'hold' as const, freeGb: 3.2, thresholdGb: 10, path: '/wt', retryMs: 300_000 };

function harness(decisions: any[] | null, opts: { stopAfterSleep?: boolean; throwing?: boolean } = {}) {
  const calls: string[] = [];
  const events: { type: string; message: string }[] = [];
  const sleeps: number[] = [];
  const toClaim = [1];
  let guardCalls = 0;
  const run = runLane('app', [], '/repo', 'on-par/software-factory', paths, {
    ship: async (issue) => {
      calls.push(`ship ${issue}`);
      return `ship-it/${issue}-x`;
    },
    waitMerge: async () => {},
    pathExists: () => opts.stopAfterSleep === true && sleeps.length > 0,
    emitEvent: ((_f: string, type: string, _i: string, message: string) => {
      events.push({ type, message });
    }) as any,
    claimNext: async () => {
      calls.push(`claim after ${guardCalls} guard calls`);
      const issue = toClaim.shift();
      return issue === undefined ? null : { issue, decision: { kind: 'build' as const } };
    },
    ...(decisions
      ? {
          diskGuard: () => {
            guardCalls++;
            if (opts.throwing) throw new Error('statfs broke');
            return decisions[Math.min(guardCalls - 1, decisions.length - 1)];
          },
        }
      : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-10-16T12:00:00.000Z'),
  });
  return { run, calls, events, sleeps };
}

describe('runLane disk guard', () => {
  it('holds the claim while disk is low, emits one disk_low event, and does not return', async () => {
    const h = harness([hold, hold, { kind: 'claim' }]);
    await h.run;
    expect(h.calls[0]).toBe('claim after 3 guard calls');
    expect(h.events.filter((e) => e.type === 'disk_low')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'warn')).toHaveLength(1);
    for (const e of h.events.filter((x) => x.message.includes('disk low'))) {
      expect(e.message).toContain('free=3.2 GB');
      expect(e.message).toContain('threshold=10 GB');
      expect(e.message).toContain('path=/wt');
    }
    expect(h.sleeps).toEqual([300_000, 300_000]);
  });

  it('resumes claiming in the same loop once disk recovers', async () => {
    const h = harness([hold, { kind: 'claim' }]);
    await h.run;
    expect(h.calls).toContain('ship 1');
  });

  it('with enough space emits no event, never sleeps for disk, and claims exactly as without the guard', async () => {
    const guarded = harness([{ kind: 'claim' }]);
    const bare = harness(null);
    await Promise.all([guarded.run, bare.run]);
    expect(guarded.events).toEqual(bare.events);
    expect(guarded.sleeps).toEqual([]);
    expect(guarded.calls.map((c) => c.replace(/after \d+ guard calls/, ''))).toEqual(
      bare.calls.map((c) => c.replace(/after \d+ guard calls/, '')),
    );
  });

  it('stops without claiming when the STOP file appears during a hold', async () => {
    const h = harness([hold], { stopAfterSleep: true });
    await h.run;
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([300_000]);
  });

  it('claims when the guard throws', async () => {
    const h = harness([], { throwing: true });
    await h.run;
    expect(h.calls).toContain('ship 1');
  });
});
