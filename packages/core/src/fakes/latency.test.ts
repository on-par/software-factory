import { describe, expect, it } from 'vitest';

import { applyLatency, realSimClock, resolveLatencyMs, type SimClock } from './latency.js';

describe('resolveLatencyMs', () => {
  it('returns 0 for undefined', () => {
    expect(resolveLatencyMs(undefined, () => 0.5)).toBe(0);
  });

  it('returns the number as-is for a plain number', () => {
    expect(resolveLatencyMs(25, () => 0.5)).toBe(25);
  });

  it('returns fixedMs for a fixed spec', () => {
    expect(resolveLatencyMs({ fixedMs: 25 }, () => 0.5)).toBe(25);
  });

  it('clamps negative values to 0', () => {
    expect(resolveLatencyMs(-10, () => 0.5)).toBe(0);
    expect(resolveLatencyMs({ fixedMs: -10 }, () => 0.5)).toBe(0);
  });

  it('resolves a uniform distribution using the injected random source', () => {
    expect(resolveLatencyMs({ minMs: 10, maxMs: 20 }, () => 0)).toBe(10);
    expect(resolveLatencyMs({ minMs: 10, maxMs: 20 }, () => 1)).toBe(20);
    expect(resolveLatencyMs({ minMs: 10, maxMs: 20 }, () => 0.5)).toBe(15);
  });

  it('returns minMs without throwing when maxMs < minMs', () => {
    expect(resolveLatencyMs({ minMs: 20, maxMs: 10 }, () => 0.5)).toBe(20);
  });
});

describe('applyLatency', () => {
  function recordingClock(random = 0.5): SimClock & { slept: number[] } {
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => random,
    };
  }

  it('sleeps exactly once for the resolved ms and returns it', async () => {
    const clock = recordingClock();
    const ms = await applyLatency({ fixedMs: 40 }, clock);
    expect(ms).toBe(40);
    expect(clock.slept).toEqual([40]);
  });

  it('does not sleep when latency is undefined', async () => {
    const clock = recordingClock();
    const ms = await applyLatency(undefined, clock);
    expect(ms).toBe(0);
    expect(clock.slept).toEqual([]);
  });

  it('does not sleep when latency resolves to 0', async () => {
    const clock = recordingClock();
    const ms = await applyLatency(0, clock);
    expect(ms).toBe(0);
    expect(clock.slept).toEqual([]);
  });
});

describe('realSimClock', () => {
  it('sleep(20) takes at least ~15ms', async () => {
    const start = performance.now();
    await realSimClock.sleep(20);
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('random() is in [0, 1)', () => {
    const value = realSimClock.random();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});
