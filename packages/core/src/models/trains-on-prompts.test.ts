import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from './index.js';

const base: ModelsConfig['models'][string] = {
  provider: 'custom',
  tier: 'worker',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
};

const config = (tiers: Record<string, string[]>): ModelsConfig => ({
  version: 1,
  models: {
    'train-model': { ...base, experimental: true, trainsOnPrompts: true },
    'real-model': base,
    'false-model': { ...base, trainsOnPrompts: false },
  },
  tiers,
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
});

describe('ModelRegistry trainsOnPrompts (#2899)', () => {
  it('excludes trainsOnPrompts models from a tier even when experimental models are allowed', () => {
    const registry = new ModelRegistry(config({ worker: ['train-model', 'real-model', 'false-model'] }));
    expect(registry.getAvailableModelsForTier('worker', false, true)).toEqual(['real-model', 'false-model']);
  });

  it('keeps a trainsOnPrompts model that is the only entry of a tier (the pin shape)', () => {
    const registry = new ModelRegistry(config({ checker: ['train-model'] }));
    expect(registry.getAvailableModelsForTier('checker', false, true)).toEqual(['train-model']);
  });

  it('treats omitted, false and unknown models as not training-eligible', () => {
    const registry = new ModelRegistry(config({}));
    expect(registry.trainsOnPrompts('train-model')).toBe(true);
    expect(registry.trainsOnPrompts('real-model')).toBe(false);
    expect(registry.trainsOnPrompts('false-model')).toBe(false);
    expect(registry.trainsOnPrompts('missing')).toBe(false);
  });
});
