// packages/cli/src/cli/run-lane-load-guard.test.ts — runLane host load guard (#3048)

import { describe, expect, it } from 'vitest';

import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
const hold = { kind: 'hold' as const, load5: 31.2, threshold: 24, cpus: 8, retryMs: 60_000 };

function harness(decisions: any[], opts: { stopAfterSleep?: boolean; throwing?: boolean } = {}) {
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
    loadGuard: () => {
      guardCalls++;
      if (opts.throwing) throw new Error('probe broke');
      return decisions[Math.min(guardCalls - 1, decisions.length - 1)];
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-10-16T12:00:00.000Z'),
  });
  return { run, calls, events, sleeps };
}

describe('runLane load guard', () => {
  it('holds the claim while load is above the threshold and logs load, threshold and retry time', async () => {
    const h = harness([hold, hold, { kind: 'claim' }]);
    await h.run;
    expect(h.calls[0]).toBe('claim after 3 guard calls');
    expect(h.calls).toContain('ship 1');
    const warns = h.events.filter((e) => e.type === 'warn');
    expect(warns).toHaveLength(2);
    for (const w of warns) {
      expect(w.message).toContain('31.20');
      expect(w.message).toContain('24');
      expect(w.message).toContain('2026-10-16T12:01:00.000Z');
    }
    expect(h.sleeps).toEqual([60_000, 60_000]);
  });

  it('claims normally when the load guard returns claim', async () => {
    const h = harness([{ kind: 'claim' }]);
    await h.run;
    expect(h.events.filter((e) => e.type === 'warn')).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toContain('ship 1');
  });

  it('stops without claiming when the STOP file appears during a hold', async () => {
    const h = harness([hold], { stopAfterSleep: true });
    await h.run;
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([60_000]);
  });

  it('claims when the load guard throws', async () => {
    const h = harness([], { throwing: true });
    await h.run;
    expect(h.calls).toContain('ship 1');
  });
});
