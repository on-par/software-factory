import { describe, expect, it, vi } from 'vitest';

import type { logEvent } from '../utils/index.js';
import { readUsage, watchUsage } from './index.js';

type EmitEventArgs = Parameters<typeof logEvent>;

const weeklyCreds = JSON.stringify({
  claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000 },
});

describe('readUsage weekly window', () => {
  it('readUsage reports the weekly window when it is the binding window', async () => {
    const reading = await readUsage({
      cap: 227,
      estimator: false,
      fetchSubscription: async () => ({
        fiveHourUtilization: 20,
        fiveHourResetsAt: '2026-10-19T03:00:00Z',
        sevenDayUtilization: 96,
        sevenDayResetsAt: '2026-10-20T12:00:00Z',
      }),
    });

    expect(reading).toEqual({
      pct: 0.96,
      source: 'subscription',
      detail: 'weekly subscription window at 96%, resets 2026-10-20T12:00:00Z',
    });
  });

  it('readUsage uses the 5h window when it is the binding window', async () => {
    const reading = await readUsage({
      cap: 227,
      estimator: false,
      fetchSubscription: async () => ({
        fiveHourUtilization: 97,
        fiveHourResetsAt: null,
        sevenDayUtilization: 40,
        sevenDayResetsAt: null,
      }),
    });

    expect(reading).toEqual({ pct: 0.97, source: 'subscription', detail: '5h subscription window at 97%' });
  });

  it('readUsage keeps the 5h detail on a tie', async () => {
    const reading = await readUsage({
      cap: 227,
      estimator: false,
      fetchSubscription: async () => ({
        fiveHourUtilization: 50,
        fiveHourResetsAt: null,
        sevenDayUtilization: 50,
        sevenDayResetsAt: null,
      }),
    });

    expect(reading?.detail).toBe('5h subscription window at 50%');
  });

  it('readUsage keeps the exact 5h pct and detail when the response has no seven_day', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization: 42, resets_at: '2026-07-15T18:00:00Z' } }));

    const reading = await readUsage({
      cap: 227,
      estimator: false,
      subscription: { platform: 'linux', readCredentialsFile: () => weeklyCreds, fetchImpl },
    });

    expect(reading).toEqual({
      pct: 0.42,
      source: 'subscription',
      detail: '5h subscription window at 42%, resets 2026-07-15T18:00:00Z',
    });
  });
});

describe('watchUsage weekly window', () => {
  it('the watchdog stops on the weekly window when the 5h window is low', async () => {
    const events: EmitEventArgs[] = [];
    const setStop = vi.fn();
    const controller = new AbortController();
    let sleeps = 0;
    const sleepFn = vi.fn(async () => {
      sleeps++;
      if (sleeps >= 3) controller.abort();
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        five_hour: { utilization: 20, resets_at: '2026-10-19T03:00:00Z' },
        seven_day: { utilization: 96, resets_at: '2026-10-20T12:00:00Z' },
      }),
    );

    await expect(
      watchUsage({
        cap: 227,
        stopAt: 0.95,
        pollMs: 1000,
        stopFile: '/repo/.factory/STOP',
        eventsFile: '/repo/.factory/events.ndjson',
        subscription: { platform: 'linux', readCredentialsFile: () => weeklyCreds, fetchImpl },
        emitEvent: (...args) => {
          events.push(args);
        },
        setStop,
        sleep: sleepFn,
        signal: controller.signal,
      }),
    ).resolves.toBe('stopped');

    expect(setStop).toHaveBeenCalledTimes(1);
    expect(setStop.mock.calls[0][0]).toBe('/repo/.factory/STOP');
    const stopEvent = events.find((e) => e[1] === 'usage-stop');
    expect(stopEvent?.[3]).toContain('weekly subscription window at 96%');
  });
});
