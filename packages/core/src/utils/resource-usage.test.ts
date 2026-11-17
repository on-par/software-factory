import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createLifecycleBus, withLifecycle, type LifecycleContext } from '../bus/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from '../logger/index.js';
import { logEvent } from './index.js';
import { startResourceMeter, type ResourceProbe } from './resource-usage.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  vi.useRealTimers();
  await tempDirs.cleanup();
});

const probe = (rss: Array<number | Error>, nan = false): ResourceProbe => {
  let c = 0;
  let r = 0;
  return {
    cpuUsage: () => (c++ ? { user: nan ? NaN : 3_500_000, system: 700_000 } : { user: 1_000_000, system: 200_000 }),
    rss: () => {
      const v = rss[Math.min(r++, rss.length - 1)] as number | Error;
      if (v instanceof Error) throw v;
      return v;
    },
  };
};

it('computes cpuMs delta and max sampled rss, clears its timer, and fails open', () => {
  vi.useFakeTimers();
  const meter = startResourceMeter(probe([150, 310, 200]), 100);
  vi.advanceTimersByTime(100);
  expect(meter.stop()).toEqual({ cpuMs: 3000, peakRssBytes: 310 });
  expect(vi.getTimerCount()).toBe(0);
  const bad = new Error('probe');
  expect(startResourceMeter(probe([bad])).stop()).toBeUndefined();
  const sampling = startResourceMeter(probe([1, bad, 1]), 10);
  vi.advanceTimersByTime(10);
  expect(sampling.stop()).toBeUndefined();
  expect(startResourceMeter(probe([1], true)).stop()).toBeUndefined();
  expect(startResourceMeter().stop()?.peakRssBytes).toBeGreaterThan(0);
});

it('flows cpuMs and peakRssBytes through withLifecycle, createLogger and logEvent', async () => {
  const logged: unknown[][] = [];
  const log = (...args: unknown[]) => void logged.push(args);
  const ctx: LifecycleContext = {
    phase: 'plan',
    issueId: 1,
    worktreePath: '/w',
    bus: createLifecycleBus(),
    log,
    resources: probe([5]),
  };
  await withLifecycle(
    ctx,
    async () => 1,
    () => true,
  );
  expect(logged[1][2]).toEqual({ durationMs: expect.any(Number), cpuMs: 3000, peakRssBytes: 5 });

  const file = join(await tempDirs.make('factory-res-'), 'events.ndjson');
  const extra = { cpuMs: 7, peakRssBytes: 9 };
  createLogger(file, {}, { out: { write: () => {} } }).info('phase_completed', 'a', extra);
  logEvent(file, 'phase_completed', 1, 'b', extra);
  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  for (const l of lines) expect(JSON.parse(l)).toMatchObject(extra);
});
