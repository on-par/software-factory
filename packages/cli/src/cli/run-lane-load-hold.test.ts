// packages/cli/src/cli/run-lane-load-hold.test.ts — runLane's host load claim gate (#3048)

import { describe, expect, it } from 'vitest';

import { holdForLoad } from './run-lane-load-hold.js';

const hold = { kind: 'hold', load5: 30, threshold: 24, cpus: 8, retryMs: 1000 } as const;

function io(stopped = false) {
  const events: unknown[][] = [];
  return {
    events,
    lane: 'app',
    paths: { events: '/e', stop: '/stop' },
    emitEvent: (...a: unknown[]) => void events.push(a),
    now: () => new Date(0),
    sleep: async () => {},
    pathExists: () => stopped,
  };
}

describe('holdForLoad', () => {
  it('claims immediately when the guard says claim', async () => {
    const i = io();
    expect(await holdForLoad(() => ({ kind: 'claim' }), i)).toBe('claim');
    expect(i.events).toEqual([]);
  });

  it('treats a throwing guard as claim', async () => {
    expect(
      await holdForLoad(() => {
        throw new Error('x');
      }, io()),
    ).toBe('claim');
  });

  it('warns and sleeps per hold, then claims once load recovers', async () => {
    const i = io();
    const decisions: Array<typeof hold | { kind: 'claim' }> = [hold, hold, { kind: 'claim' } as const];
    const next = () => decisions.shift() ?? { kind: 'claim' as const };
    expect(await holdForLoad(next, i)).toBe('claim');
    expect(i.events.map((e) => e[1])).toEqual(['warn', 'warn']);
  });

  it('stops when STOP appears during the hold', async () => {
    expect(await holdForLoad(() => hold, io(true))).toBe('stopped');
  });
});
