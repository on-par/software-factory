import { describe, expect, it } from 'vitest';

import { type ModelsConfig } from './index.js';
import { applyRepoConfig } from './repo.js';

function baseModel(overrides: Partial<ModelsConfig['models'][string]>): ModelsConfig['models'][string] {
  return {
    provider: 'anthropic',
    tier: [],
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

const models: ModelsConfig = {
  version: 1,
  models: {
    'gpt-model-a': baseModel({ tier: 'worker', provider: 'openai' }),
    'triage-model': baseModel({ tier: 'triage' }),
  },
  tiers: { worker: ['gpt-model-a'], triage: ['triage-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};

describe('triage_cheap follows triage (#783)', () => {
  const withCheap: ModelsConfig = {
    ...models,
    tiers: { ...models.tiers, triage_cheap: ['triage-model', 'gpt-model-a'] },
  };

  it('pins.triage sets both triage and triage_cheap', () => {
    const result = applyRepoConfig(withCheap, { version: 2, models: { pins: { triage: 'triage-model' } } });
    expect(result.tiers.triage).toEqual(['triage-model']);
    expect(result.tiers.triage_cheap).toEqual(['triage-model']);
  });

  it('tiers.triage without triage_cheap copies the list', () => {
    const result = applyRepoConfig(withCheap, { version: 2, tiers: { triage: ['gpt-model-a'] } });
    expect(result.tiers.triage_cheap).toEqual(['gpt-model-a']);
  });

  it('keeps an explicit tiers.triage_cheap', () => {
    const result = applyRepoConfig(withCheap, {
      version: 2,
      tiers: { triage: ['gpt-model-a'], triage_cheap: ['triage-model'] },
    });
    expect(result.tiers.triage_cheap).toEqual(['triage-model']);
  });

  it('adds no triage_cheap key when the packaged config has none', () => {
    const pinned = applyRepoConfig(models, { version: 2, models: { pins: { triage: 'triage-model' } } });
    const tiered = applyRepoConfig(models, { version: 2, tiers: { triage: ['gpt-model-a'] } });
    expect(pinned.tiers).not.toHaveProperty('triage_cheap');
    expect(tiered.tiers).not.toHaveProperty('triage_cheap');
  });
});
