import { describe, expect, it } from 'vitest';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from './index.js';

const config = (cachedRate?: number): ModelsConfig => ({
  version: 1,
  models: {
    priced: {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 2,
      costPerMtokOutput: 4,
      ...(cachedRate === undefined ? {} : { costPerMtokCachedInput: cachedRate }),
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
    free: {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['priced', 'free'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
});

describe('ModelRegistry cached input pricing', () => {
  it('keeps ordinary input pricing when there are no cache reads', () => {
    expect(new ModelRegistry(config()).estimateCost('priced', { inputTokens: 1_000_000, outputTokens: 0 })).toEqual({
      cost: 2,
      cachedRateMissing: false,
    });
  });

  it('accepts an explicit zero cached rate', () => {
    expect(
      new ModelRegistry(config(0)).estimateCost('priced', { inputTokens: 100, outputTokens: 0, cacheReadTokens: 100 }),
    ).toEqual({ cost: 0, cachedRateMissing: false });
  });

  it('flags only positive cache reads when the cached rate is absent', () => {
    expect(
      new ModelRegistry(config()).estimateCost('priced', { inputTokens: 100, outputTokens: 0, cacheReadTokens: 1 }),
    ).toEqual({ cost: 0.0002, cachedRateMissing: true });
  });

  it('normalizes invalid and excessive cache reads', () => {
    const registry = new ModelRegistry(config(0.5));
    expect(registry.estimateCost('priced', { inputTokens: 100, outputTokens: 0, cacheReadTokens: -1 }).cost).toBe(
      0.0002,
    );
    expect(
      registry.estimateCost('priced', { inputTokens: 100, outputTokens: 0, cacheReadTokens: Number.NaN }).cost,
    ).toBe(0.0002);
    expect(registry.estimateCost('priced', { inputTokens: 100, outputTokens: 0, cacheReadTokens: 200 }).cost).toBe(
      0.00005,
    );
  });

  it('keeps registered free models numeric and unknown models unpriced', () => {
    const registry = new ModelRegistry(config());
    expect(registry.estimateCost('free', { inputTokens: 100, outputTokens: 100, cacheReadTokens: 50 })).toEqual({
      cost: 0,
      cachedRateMissing: true,
    });
    expect(registry.estimateCost('', { inputTokens: 100, outputTokens: 100, cacheReadTokens: 50 })).toEqual({
      cost: null,
      cachedRateMissing: false,
    });
  });
});
