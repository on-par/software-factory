// packages/cli/src/cli/supervise-loop.test.ts — superviseLoop tests, moved from cli.test.ts (#2797)

import { describe, expect, it } from 'vitest';

import { superviseLoop } from './index.js';

describe('superviseLoop', () => {
  function reading(pct: number, source: 'subscription' | 'estimate' = 'subscription') {
    return { pct, source, detail: `detail at ${Math.round(pct * 100)}%` };
  }

  it('waits for the resume gate, runs the queue, and loops again while STOP is present', async () => {
    const calls: any[] = [];
    const readings = [reading(0.9), reading(0.9), reading(0.5), reading(0.5)];
    const pathExistsResults = [true, false];
    let runQueueCalls = 0;

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => readings.shift()!,
      pathExists: () => pathExistsResults.shift()!,
      clearStop: (path) => calls.push(['clearStop', path]),
      sleep: async () => {
        calls.push(['sleep']);
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) => {
        calls.push(['event', type, issue, msg]);
      },
      writeLine: (line) => calls.push(['writeLine', line]),
      runQueue: async () => {
        runQueueCalls++;
        calls.push(['runQueue']);
      },
    });

    expect(runQueueCalls).toBe(2);
    const firstRunQueueIdx = calls.findIndex((c) => c[0] === 'runQueue');
    const firstSleepIdx = calls.findIndex((c) => c[0] === 'sleep');
    expect(firstSleepIdx).toBeGreaterThanOrEqual(0);
    expect(firstSleepIdx).toBeLessThan(firstRunQueueIdx);

    const clearStopCalls = calls.filter((c) => c[0] === 'clearStop');
    expect(clearStopCalls).toHaveLength(2);

    const events = calls.filter((c) => c[0] === 'event');
    expect(events.filter((e) => e[1] === 'resumed')).toHaveLength(2);
    expect(events.filter((e) => e[1] === 'supervisor-done')).toHaveLength(1);
    expect(events[events.length - 1][1]).toBe('supervisor-done');
    expect(events[0][3]).toContain('(subscription)');
  });

  it('exits after one cycle when the queue drains without STOP present', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: true,
      readUsageFn: async () => reading(0.1),
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {
        calls.push(['sleep']);
      },
      emitEvent: (_eventsFile: string, type: string) => {
        calls.push(['event', type]);
      },
      runQueue: async () => {
        calls.push(['runQueue']);
      },
    });

    expect(calls.filter((c) => c[0] === 'runQueue')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(0);
    expect(calls.filter((c) => c[0] === 'event' && c[1] === 'supervisor-done')).toHaveLength(1);
  });

  it('skips the initial headroom wait when --now is set', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: true,
      readUsageFn: async () => reading(0.9),
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {
        calls.push(['sleep']);
      },
      emitEvent: () => {},
      runQueue: async () => {
        calls.push(['runQueue']);
      },
    });

    expect(calls).toEqual([['runQueue']]);
  });

  it('re-checks the resume gate after each wait', async () => {
    const calls: any[] = [];
    const readings = [reading(0.9), reading(0.9), reading(0.5)];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => readings.shift()!,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      runQueue: async () => {},
    });

    expect(calls).toHaveLength(2);
  });

  it('falls back to unavailable and stops waiting when a poll inside the resume gate returns null', async () => {
    const calls: any[] = [];
    const readings: Array<ReturnType<typeof reading> | null> = [reading(0.9), null];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => readings.shift() ?? null,
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

    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(1);
    expect(calls).toContainEqual(['runQueue']);
    expect(calls.some((c) => c[0] === 'writeLine' && c[1].includes('usage signal unavailable'))).toBe(true);
  });

  it('skips the resume gate entirely when watch is false, even with a readUsageFn that would gate', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: false,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => reading(1.6),
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

    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(0);
    expect(calls.filter((c) => c[0] === 'runQueue')).toHaveLength(1);
  });

  it('usage-watch flag: superviseLoop attributes a skipped resume gate to --no-usage-watch', async () => {
    const calls: string[] = [];
    let usageReads = 0;
    let sleeps = 0;

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: false,
      watchSource: 'flag',
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      readUsageFn: async () => {
        usageReads++;
        return reading(1);
      },
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {
        sleeps++;
      },
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      runQueue: async () => {},
    });

    expect(calls).toContain(
      '[factory] supervise: usage watchdog disabled (flag: --no-usage-watch) — skipping resume gate',
    );
    expect(usageReads).toBe(0);
    expect(sleeps).toBe(0);
  });

  it('usage-watch repo config: superviseLoop attributes a skipped resume gate to the loaded config file (#2570)', async () => {
    const calls: string[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: false,
      watchSource: 'repo',
      repoConfigLabel: '.factory/config.yaml',
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      readUsageFn: async () => reading(1),
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      runQueue: async () => {},
    });

    expect(calls.join('\n')).toContain('.factory/config.yaml: budget.watchdog.watch');
  });

  it('usage-watch flag: superviseLoop logs --usage-watch when the flag forces the gate on', async () => {
    const calls: string[] = [];
    let runQueueCalls = 0;

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: true,
      watchSource: 'flag',
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      readUsageFn: async () => reading(0.1),
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      runQueue: async () => {
        runQueueCalls++;
      },
    });

    expect(calls).toContain(
      '[factory] supervise: usage watchdog enabled (flag: --usage-watch) — enforcing resume gate',
    );
    expect(runQueueCalls).toBe(1);
  });

  it('usage threshold and poll flags: superviseLoop logs supplied flag sources', async () => {
    const lines: string[] = [];
    const events: any[] = [];
    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      resumeAtSource: 'flag',
      pollSource: 'flag',
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      readUsageFn: async () => reading(0.1),
      pathExists: () => false,
      clearStop: () => {},
      emitEvent: (...args: any[]) => events.push(args),
      writeLine: (line) => lines.push(line),
      runQueue: async () => {},
    });
    expect(lines).toContain('[factory] supervise: usage watchdog threshold set by flag: --usage-threshold');
    expect(lines).toContain('[factory] supervise: usage watchdog poll set by flag: --usage-poll');
    expect(events.map((event) => event[3])).toEqual(
      expect.arrayContaining([
        'usage watchdog threshold set by flag: --usage-threshold',
        'usage watchdog poll set by flag: --usage-poll',
      ]),
    );
  });

  it('usage-watch flag: superviseLoop logs no source line when no flag was supplied', async () => {
    const calls: string[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: true,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      readUsageFn: async () => reading(0.1),
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      runQueue: async () => {},
    });

    expect(calls.some((line) => line.includes('usage watchdog enabled'))).toBe(false);
  });

  it('proceeds immediately without gating when the usage reading is null, logging the unavailable warning', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: false,
      readUsageFn: async () => null,
      pathExists: () => false,
      clearStop: () => {},
      sleep: async () => {
        calls.push(['sleep']);
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) => {
        calls.push(['event', type, issue, msg]);
      },
      writeLine: (line) => calls.push(['writeLine', line]),
      runQueue: async () => {
        calls.push(['runQueue']);
      },
    });

    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(0);
    expect(calls.filter((c) => c[0] === 'runQueue')).toHaveLength(1);
    expect(calls.some((c) => c[0] === 'writeLine' && c[1].includes('usage signal unavailable'))).toBe(true);
    const resumedEvent = calls.find((c) => c[0] === 'event' && c[1] === 'resumed');
    expect(resumedEvent[3]).toContain('(unavailable)');
  });

  it('without an ingest dep, keeps the existing drain-and-exit behavior (one runQueue, breaks when STOP absent)', async () => {
    const calls: any[] = [];

    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1000,
      watch: false,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      now: true,
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

    expect(calls.filter((c) => c[0] === 'runQueue')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(0);
  });

  it('with an ingest dep, polls again after runQueue while STOP stays absent, and logs appended counts', async () => {
    const calls: any[] = [];
    let ingestCalls = 0;
    let runQueueCalls = 0;

    await expect(
      superviseLoop({
        cap: 1,
        resumeAt: 0.65,
        pollMs: 1000,
        watch: false,
        stopFile: '/repo/.factory/STOP',
        eventsFile: '/repo/.factory/events.ndjson',
        now: true,
        pathExists: () => false,
        clearStop: () => {},
        sleep: async () => {
          calls.push(['sleep']);
        },
        emitEvent: () => {},
        writeLine: (line) => calls.push(['writeLine', line]),
        runQueue: async () => {
          runQueueCalls++;
          calls.push(['runQueue']);
        },
        ingest: async () => {
          ingestCalls++;
          if (ingestCalls >= 3) throw new Error('stop the test loop');
          return ingestCalls === 1 ? 2 : 0;
        },
      }),
    ).rejects.toThrow('stop the test loop');

    expect(runQueueCalls).toBe(2);
    expect(calls.filter((c) => c[0] === 'sleep')).toHaveLength(2);
    expect(calls).toContainEqual(['writeLine', '[factory] supervise: auto-ingest appended 2 ready issue(s)']);
  });
});
