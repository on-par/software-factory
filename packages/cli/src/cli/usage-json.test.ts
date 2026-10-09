import { describe, expect, it } from 'vitest';

import { buildUsageJson } from './usage-json.js';

describe('buildUsageJson', () => {
  it('reports the subscription reading', () => {
    expect(buildUsageJson({ fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' }, 12.5, 100)).toEqual({
      schemaVersion: 1,
      source: 'subscription',
      utilizationPct: 42,
      resetsAt: '2026-07-15T18:00:00Z',
      windowHours: 5,
      estimateUsd: 12.5,
    });
  });

  it('keeps null resetsAt and estimate on a subscription reading', () => {
    const json = buildUsageJson({ fiveHourUtilization: 10, fiveHourResetsAt: null }, null, 100);
    expect(json.source).toBe('subscription');
    expect(json.resetsAt).toBeNull();
    expect(json.estimateUsd).toBeNull();
  });

  it('falls back to the heuristic against the cap', () => {
    const json = buildUsageJson(null, 30, 200);
    expect(json).toMatchObject({ source: 'heuristic', utilizationPct: 15, resetsAt: null, estimateUsd: 30 });
  });

  it('treats a zero estimate as a real heuristic reading', () => {
    expect(buildUsageJson(null, 0, 100)).toMatchObject({ source: 'heuristic', estimateUsd: 0, utilizationPct: 0 });
  });

  it('is unavailable with explicit nulls, never 0', () => {
    const json = buildUsageJson(null, null, 100);
    expect(json).toEqual({
      schemaVersion: 1,
      source: 'unavailable',
      utilizationPct: null,
      resetsAt: null,
      windowHours: 5,
      estimateUsd: null,
    });
    expect(json.estimateUsd).not.toBe(0);
  });
});
