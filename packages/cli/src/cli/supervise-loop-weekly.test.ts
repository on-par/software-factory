import { describe, expect, it } from 'vitest';

import { superviseLoop } from './index.js';

describe('superviseLoop weekly window', () => {
  it('the resume gate waits on the weekly window and logs its detail', async () => {
    const calls: Array<[string, string?]> = [];
    const weekly = (pct: number) => ({
      pct,
      source: 'subscription' as const,
      detail: `weekly subscription window at ${Math.round(pct * 100)}%, resets 2026-10-20T12:00:00Z`,
    });
    const readings = [weekly(0.85), weekly(0.85), weekly(0.79)];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.8,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => readings.shift()!,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {
        calls.push(['sleep']);
      },
      emitEvent: () => {},
      writeLine: (line) => calls.push(['writeLine', line]),
      runQueue: async () => {
        calls.push(['runQueue']);
      },
    });

    expect(calls.some((c) => c[0] === 'writeLine' && c[1]?.includes('weekly subscription window at 85%'))).toBe(true);
    expect(calls.findIndex((c) => c[0] === 'sleep')).toBeLessThan(calls.findIndex((c) => c[0] === 'runQueue'));
    expect(calls.filter((c) => c[0] === 'runQueue')).toHaveLength(1);
  });
});
