import { describe, expect, it, vi } from 'vitest';
import type { HarnessUsage } from '../harness/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

function costRouter(usage: HarnessUsage, cachedRate?: number) {
  const models: ModelsConfig = {
    version: 1,
    models: {
      m: {
        provider: 'custom',
        tier: 'boss',
        costPerMtokInput: 1.25,
        costPerMtokOutput: 10,
        ...(cachedRate === undefined ? {} : { costPerMtokCachedInput: cachedRate }),
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
    },
    tiers: { boss: ['m'] },
    failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
    routingRules: {},
  };
  const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'test' } } };
  const executor = new StubModelExecutor({
    scripts: { plan: [{ output: 'ok', effect: (ctx) => ctx.onUsage?.(usage) }] },
  });
  return new ModelRouter(models, routes, false, executor);
}

describe('ModelRouter cache pricing', () => {
  it('prices the #3264 BUILD usage at the cached-input rate and forwards successful usage', async () => {
    const router = costRouter({ inputTokens: 25_573_945, outputTokens: 0, cacheReadTokens: 24_881_152 }, 0.125);
    const rows: Array<{ cost: number | null; cachedRateMissing?: boolean }> = [];
    router.setCostSink((entry) => rows.push(entry));
    const result = await router.run('plan', 'do it');
    expect(rows[0]?.cost).toBeCloseTo(3.97613525, 4);
    expect(rows[0]?.cachedRateMissing).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 25_573_945, cacheReadTokens: 24_881_152 });
  });

  it('flags full-input fallback for the #3264 BUILD row without a cached rate', async () => {
    const router = costRouter({ inputTokens: 25_573_945, outputTokens: 0, cacheReadTokens: 24_881_152 });
    const rows: Array<{ cost: number | null; cachedRateMissing?: boolean }> = [];
    router.setCostSink((entry) => rows.push(entry));
    const result = await router.run('plan', 'do it');
    expect(rows[0]?.cost).toBeCloseTo(31.96743125, 4);
    expect(rows[0]?.cachedRateMissing).toBe(true);
    expect(result.usage?.cacheReadTokens).toBe(24_881_152);
  });

  it('preserves provider zero dollars and bypasses estimation', async () => {
    const router = costRouter({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0 });
    const estimate = vi.spyOn(router.registryRef, 'estimateCost');
    const rows: Array<{ cost: number | null; cachedRateMissing?: boolean }> = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('plan', 'do it');
    expect(rows[0]?.cost).toBe(0);
    expect(rows[0]).not.toHaveProperty('cachedRateMissing');
    expect(estimate).not.toHaveBeenCalled();
  });
});
