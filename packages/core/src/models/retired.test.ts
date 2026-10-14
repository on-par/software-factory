import { describe, expect, it } from 'vitest';

import { applyRepoConfig, resolveEffectiveModelPins } from '../config/repo.js';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry, resolveModelOverrides, retiredModelHint } from './index.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('retired model hint (ADR-0163)', () => {
  const registry = new ModelRegistry(models);

  it('a deepseek-v3 build pin fails naming ADR-0163 and opencode-deepseek-v4-flash', () => {
    const run = () =>
      resolveEffectiveModelPins(registry, { version: 2, models: { pins: { build: 'deepseek-v3' } } }, {});
    expect(run).toThrow(/ADR-0163/);
    expect(run).toThrow(/opencode-deepseek-v4-flash/);
  });

  it('a deepseek-v3 tier override carries the hint', () => {
    expect(() => applyRepoConfig(models, { version: 2, tiers: { worker: ['deepseek-v3'] } })).toThrow(
      /unknown model 'deepseek-v3'.*ADR-0163.*opencode-deepseek-v4-flash/,
    );
  });

  it('an unrelated unknown pin carries no hint', () => {
    let message = '';
    try {
      resolveEffectiveModelPins(registry, { version: 2, models: { pins: { build: 'no-such-model' } } }, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/unknown model 'no-such-model'/);
    expect(message).not.toContain('ADR-0163');
  });

  it('FACTORY_BUILD_MODEL=deepseek-v3 throws with the hint', () => {
    expect(() => resolveModelOverrides(registry, { FACTORY_BUILD_MODEL: 'deepseek-v3' })).toThrow(
      /ADR-0163.*opencode-deepseek-v4-flash/,
    );
  });

  it('retiredModelHint is empty for any other id', () => {
    expect(retiredModelHint('other')).toBe('');
    expect(retiredModelHint('toString')).toBe('');
  });
});
