import { describe, expect, it } from 'vitest';

import { buildUsageJson, collectUsageJson } from './usage-json.js';
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
    const json = buildUsageJson(null, 30, 200, 'api');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ source: 'heuristic', utilizationPct: 15, resetsAt: null, estimateUsd: 30 });
  });

  it('treats a zero estimate as a real heuristic reading', () => {
    const json = buildUsageJson(null, 0, 100, 'unknown');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toMatchObject({ source: 'heuristic', estimateUsd: 0, utilizationPct: 0 });
  });

  it('is unavailable with explicit nulls, never 0', () => {
    const json = buildUsageJson(null, null, 100, 'unknown');
    expect(usageJsonSchema.parse(json)).toEqual(json);
    expect(json).toEqual({
      schemaVersion: 1,
      source: 'unavailable',
      utilizationPct: null,
      resetsAt: null,
      windowHours: 5,
      estimateUsd: null,
      plan: 'unknown',
    });
    expect(json.estimateUsd).not.toBe(0);
  });

  it('buildUsageJson emits plan for every source and keeps the other fields', () => {
    const keys = ['schemaVersion', 'source', 'utilizationPct', 'resetsAt', 'windowHours', 'estimateUsd', 'plan'];
    const sub = buildUsageJson(
      { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' },
      12.5,
      100,
      'subscription',
    );
    const heur = buildUsageJson(null, 30, 200, 'api');
    const none = buildUsageJson(null, null, 100, 'unknown');
    expect([sub.plan, heur.plan, none.plan]).toEqual(['subscription', 'api', 'unknown']);
    for (const json of [sub, heur, none]) {
      expect(Object.keys(json).sort()).toEqual([...keys].sort());
      expect(usageJsonSchema.parse(json)).toEqual(json);
    }
    expect(sub).toMatchObject({
      source: 'subscription',
      utilizationPct: 42,
      resetsAt: '2026-07-15T18:00:00Z',
      windowHours: 5,
      estimateUsd: 12.5,
    });
    expect(heur).toMatchObject({ source: 'heuristic', utilizationPct: 15, estimateUsd: 30 });
    expect(none).toMatchObject({ source: 'unavailable', utilizationPct: null, estimateUsd: null });
  });
});

describe('collectUsageJson', () => {
  const ops = {
    fetchSubscriptionUsage: async () => null,
    estimateTrailingSpend: () => 10,
    detectClaudePlan: () => 'api' as const,
  };

  it('carries the detected plan into the payload', async () => {
    expect(await collectUsageJson(ops, 100)).toMatchObject({ source: 'heuristic', estimateUsd: 10, plan: 'api' });
  });

  it('uses a null estimate when the estimator throws or is not finite', async () => {
    const thrower = {
      ...ops,
      estimateTrailingSpend: () => {
        throw new Error('boom');
      },
    };
    expect(await collectUsageJson(thrower, 100)).toMatchObject({
      source: 'unavailable',
      estimateUsd: null,
      plan: 'api',
    });
    expect(await collectUsageJson({ ...ops, estimateTrailingSpend: () => Number.NaN }, 100)).toMatchObject({
      estimateUsd: null,
    });
  });
});
