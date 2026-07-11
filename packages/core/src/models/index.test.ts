import { describe, expect, it } from 'vitest';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from './index.js';

const config: ModelsConfig = {
  version: 1,
  models: {
    'exp-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      experimental: true,
    },
    'real-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['exp-model', 'real-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('ModelRegistry', () => {
  it('excludes experimental models by default, even when listed first', () => {
    const registry = new ModelRegistry(config);
    expect(registry.getAvailableModelsForTier('boss')).toEqual(['real-model']);
  });

  it('includes experimental models when opted in', () => {
    const registry = new ModelRegistry(config);
    expect(registry.getAvailableModelsForTier('boss', false, true)).toEqual(['exp-model', 'real-model']);
  });

  it('reports experimental status per model', () => {
    const registry = new ModelRegistry(config);
    expect(registry.isExperimental('exp-model')).toBe(true);
    expect(registry.isExperimental('real-model')).toBe(false);
    expect(registry.isExperimental('missing')).toBe(false);
  });
});
