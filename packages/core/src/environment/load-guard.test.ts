import { describe, expect, it } from 'vitest';

import { evaluateLoadGuard, formatLoadHold, loadGuardThreshold, readHostLoad } from './load-guard.js';

const policy = { enabled: true, retryMs: 60_000 };

describe('load guard', () => {
  it('returns claim when the 5-minute load is at or below 3x CPU count', () => {
    expect(evaluateLoadGuard(policy, { load5: 24, cpus: 8 })).toEqual({ kind: 'claim' });
    expect(evaluateLoadGuard(policy, { load5: 1, cpus: 8 })).toEqual({ kind: 'claim' });
  });

  it('holds above 3x CPU count', () => {
    expect(evaluateLoadGuard(policy, { load5: 24.01, cpus: 8 })).toEqual({
      kind: 'hold',
      load5: 24.01,
      threshold: 24,
      cpus: 8,
      retryMs: 60_000,
    });
  });

  it('returns claim whatever the load when the guard is disabled', () => {
    expect(evaluateLoadGuard({ ...policy, enabled: false }, { load5: 550, cpus: 8 })).toEqual({ kind: 'claim' });
  });

  it('honours the maxLoad override', () => {
    const d = evaluateLoadGuard({ ...policy, maxLoad: 10 }, { load5: 11, cpus: 64 });
    expect(d).toMatchObject({ kind: 'hold', threshold: 10 });
  });

  it('fails open on non-finite load and floors cpus at 1', () => {
    expect(evaluateLoadGuard(policy, { load5: Number.NaN, cpus: 8 })).toEqual({ kind: 'claim' });
    expect(evaluateLoadGuard(policy, { load5: Number.POSITIVE_INFINITY, cpus: 8 })).toEqual({ kind: 'claim' });
    expect(loadGuardThreshold(policy, 0)).toBe(3);
  });

  it('reads load from the probe', () => {
    expect(readHostLoad({ loadavg: () => [1, 7.5, 9], cpus: () => [{}, {}] })).toEqual({ load5: 7.5, cpus: 2 });
    expect(readHostLoad({ loadavg: () => [], cpus: () => [] }).load5).toBeNaN();
  });

  it('reads the real host', () => {
    expect(readHostLoad().cpus).toBeGreaterThanOrEqual(0);
  });

  it('formats the hold message', () => {
    const msg = formatLoadHold(
      'app',
      { kind: 'hold', load5: 31.2, threshold: 24, cpus: 8, retryMs: 60_000 },
      new Date('2026-10-16T12:01:00.000Z'),
    );
    expect(msg).toContain('31.20');
    expect(msg).toContain('24');
    expect(msg).toContain('8 CPUs');
    expect(msg).toContain('2026-10-16T12:01:00.000Z');
  });
});
