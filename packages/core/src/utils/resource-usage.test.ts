import { afterEach, describe, expect, it, vi } from 'vitest';

import { startResourceMeter, type ResourceProbe } from './resource-usage.js';

const MIB = 1024 * 1024;

function fixtureProbe(cpu: Array<{ user: number; system: number }>, rss: Array<number | Error>): ResourceProbe {
  let c = 0;
  let r = 0;
  return {
    cpuUsage: () => cpu[Math.min(c++, cpu.length - 1)] as { user: number; system: number },
    rss: () => {
      const v = rss[Math.min(r++, rss.length - 1)] as number | Error;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

describe('startResourceMeter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes cpuMs from the user+system delta and peakRssBytes as the max sampled rss (fixture)', () => {
    vi.useFakeTimers();
    const probe = fixtureProbe(
      [
        { user: 1_000_000, system: 200_000 },
        { user: 3_500_000, system: 700_000 },
      ],
      [150 * MIB, 310 * MIB, 200 * MIB],
    );
    const meter = startResourceMeter(probe, { sampleIntervalMs: 100 });
    vi.advanceTimersByTime(100);
    expect(meter.stop()).toEqual({ cpuMs: 3000, peakRssBytes: 310 * MIB });
  });

  it('returns undefined instead of throwing when the probe throws at start, during sampling or at stop', () => {
    vi.useFakeTimers();
    const boom = new Error('probe');

    const atStart = startResourceMeter({
      cpuUsage: () => {
        throw boom;
      },
      rss: () => 1,
    });
    expect(atStart.stop()).toBeUndefined();

    const duringSampling = startResourceMeter(fixtureProbe([{ user: 0, system: 0 }], [1, boom, 1]), {
      sampleIntervalMs: 10,
    });
    vi.advanceTimersByTime(10);
    expect(duringSampling.stop()).toBeUndefined();

    let calls = 0;
    const atStop = startResourceMeter({
      cpuUsage: () => {
        if (calls++ > 0) throw boom;
        return { user: 0, system: 0 };
      },
      rss: () => 1,
    });
    expect(atStop.stop()).toBeUndefined();
  });

  it('returns undefined when a value is not finite', () => {
    const meter = startResourceMeter(
      fixtureProbe(
        [
          { user: 0, system: 0 },
          { user: Number.NaN, system: 0 },
        ],
        [1],
      ),
    );
    expect(meter.stop()).toBeUndefined();
  });

  it('uses the real process probe by default and returns plausible values', () => {
    const sample = startResourceMeter().stop();
    expect(sample?.cpuMs).toBeGreaterThanOrEqual(0);
    expect(sample?.peakRssBytes).toBeGreaterThan(0);
  });

  it('clears its sampling interval on stop', () => {
    vi.useFakeTimers();
    const meter = startResourceMeter(fixtureProbe([{ user: 0, system: 0 }], [1]));
    expect(vi.getTimerCount()).toBe(1);
    meter.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
