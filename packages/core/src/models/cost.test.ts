import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from './index.js';

const config: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { boss: [] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

describe('estimateCost cache-read pricing (#3284)', () => {
  const cachedRegistry = (cached?: number) =>
    new ModelRegistry({
      ...config,
      models: {
        ...config.models,
        'cached-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 1.25,
          costPerMtokOutput: 10,
          ...(cached === undefined ? {} : { costPerMtokCachedInput: cached }),
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
    });
  const build3264 = { inputTokens: 25_102_465, cacheReadTokens: 24_881_152, outputTokens: 58_935 };

  it('estimateCost prices cache reads at the cached-input rate (#3264 BUILD row)', () => {
    const est = cachedRegistry(0.125).estimateCost('cached-model', build3264);
    expect(est.cost).toBeCloseTo(3.9761, 4);
    expect(est.cachedRateMissing).toBe(false);
  });

  it('prices cache reads at the input rate and flags the estimate when no cached rate is set', () => {
    const est = cachedRegistry().estimateCost('cached-model', build3264);
    expect(est.cost).toBeCloseTo(31.9674, 4);
    expect(est.cachedRateMissing).toBe(true);
  });

  it('prices exactly as before with no cache reads (undefined or 0) and never flags', () => {
    const registry = cachedRegistry();
    const base = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(registry.estimateCost('cached-model', base)).toEqual({ cost: 11.25, cachedRateMissing: false });
    expect(registry.estimateCost('cached-model', { ...base, cacheReadTokens: 0 })).toEqual({
      cost: 11.25,
      cachedRateMissing: false,
    });
  });

  it('clamps malformed cache reads to a finite, non-negative cost', () => {
    const registry = cachedRegistry(0.125);
    const base = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(registry.estimateCost('cached-model', { ...base, cacheReadTokens: 5_000_000 }).cost).toBeCloseTo(0.125);
    expect(registry.estimateCost('cached-model', { ...base, cacheReadTokens: Number.NaN }).cost).toBeCloseTo(1.25);
    expect(registry.estimateCost('cached-model', { ...base, cacheReadTokens: -5 }).cost).toBeCloseTo(1.25);
  });

  it('treats a zero cached rate as set: cache reads are free and not flagged', () => {
    const est = cachedRegistry(0).estimateCost('cached-model', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(est).toEqual({ cost: 0, cachedRateMissing: false });
  });

  it('returns cost null and no flag for an unknown model', () => {
    expect(new ModelRegistry(config).estimateCost('nope', build3264)).toEqual({ cost: null, cachedRateMissing: false });
  });
});
