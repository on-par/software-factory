import { describe, expect, it } from 'vitest';

import { buildUsageJson } from './usage-json.js';
import { usageJsonSchema } from './json-contract.js';

describe('buildUsageJson', () => {
  it('reports the subscription reading', () => {
    const output = buildUsageJson(
      { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' },
      12.5,
      100,
      'subscription',
    );
    expect(usageJsonSchema.parse(output)).toEqual(output);
    expect(output).toEqual({
      schemaVersion: 1,
      source: 'subscription',
      utilizationPct: 42,
      resetsAt: '2026-07-15T18:00:00Z',
      windowHours: 5,
      estimateUsd: 12.5,
      plan: 'subscription',
    });
  });

  it('keeps null resetsAt and estimate on a subscription reading', () => {
    const json = buildUsageJson({ fiveHourUtilization: 10, fiveHourResetsAt: null }, null, 100, 'subscription');
    expect(json.source).toBe('subscription');
    expect(json.resetsAt).toBeNull();
    expect(json.estimateUsd).toBeNull();
  });

  it('falls back to the heuristic against the cap', () => {
    const json = buildUsageJson(null, 30, 200, 'subscription');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ source: 'heuristic', utilizationPct: 15, resetsAt: null, estimateUsd: 30 });
  });

  it('treats a zero estimate as a real heuristic reading', () => {
    const json = buildUsageJson(null, 0, 100, 'subscription');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ source: 'heuristic', estimateUsd: 0, utilizationPct: 0 });
  });

  it('is unavailable with explicit nulls, never 0', () => {
    const json = buildUsageJson(null, null, 100, 'subscription');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toEqual({
      schemaVersion: 1,
      source: 'unavailable',
      utilizationPct: null,
      resetsAt: null,
      windowHours: 5,
      estimateUsd: null,
      plan: 'subscription',
    });
    expect(json.estimateUsd).not.toBe(0);
  });

  it('buildUsageJson emits plan for every source without changing the other fields', () => {
    const sub = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
    for (const plan of ['api', 'subscription', 'unknown'] as const) {
      const a = buildUsageJson(sub, 12.5, 100, plan);
      expect(a).toMatchObject({
        source: 'subscription',
        utilizationPct: 42,
        resetsAt: sub.fiveHourResetsAt,
        windowHours: 5,
        estimateUsd: 12.5,
        plan,
      });
      const b = buildUsageJson(null, 30, 200, plan);
      expect(b).toMatchObject({
        source: 'heuristic',
        utilizationPct: 15,
        resetsAt: null,
        windowHours: 5,
        estimateUsd: 30,
        plan,
      });
      const c = buildUsageJson(null, null, 100, plan);
      expect(c).toMatchObject({
        source: 'unavailable',
        utilizationPct: null,
        resetsAt: null,
        windowHours: 5,
        estimateUsd: null,
        plan,
      });
      for (const out of [a, b, c]) {
        expect(usageJsonSchema.parse(out)).toEqual(out);
        expect(JSON.stringify(out)).not.toContain('sk-ant-sample-key');
      }
    }
  });
});
