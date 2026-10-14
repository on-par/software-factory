import { defaultModelsConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { applyRepoConfig, resolveEffectiveModelPins } from './repo.js';

const free = 'opencode-deepseek-v4-flash-free';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trainsOnPrompts models (#2899)', () => {
  it('throws naming a trainsOnPrompts model in a repo tier and says to pin it instead', () => {
    expect(() => applyRepoConfig(defaultModelsConfig, { version: 2, tiers: { worker: [free] } })).toThrow(
      /tier 'worker'.*opencode-deepseek-v4-flash-free.*pin it instead/is,
    );
  });

  it('refuses a models.registry model declared with trainsOnPrompts in a repo tier', () => {
    const repo = {
      version: 2,
      models: {
        registry: {
          'train-model': {
            provider: 'custom',
            tier: 'worker',
            costPerMtokInput: 0,
            costPerMtokOutput: 0,
            contextWindow: 1000,
            capabilities: [],
            envKey: null,
            trainsOnPrompts: true,
          },
        },
      },
      tiers: { worker: ['train-model'] },
    } as NonNullable<Parameters<typeof applyRepoConfig>[1]>;
    expect(() => applyRepoConfig(defaultModelsConfig, repo)).toThrow(/train-model.*pin it instead/is);
  });

  it('still fires the unknown-model error first for an unknown id', () => {
    expect(() => applyRepoConfig(defaultModelsConfig, { version: 2, tiers: { worker: ['nope'] } })).toThrow(
      /unknown model 'nope'/,
    );
  });

  it('resolves a build pin to a trainsOnPrompts model', () => {
    const pins = resolveEffectiveModelPins(
      new ModelRegistry(defaultModelsConfig),
      { version: 2, models: { pins: { build: free } } },
      {},
    );
    expect(pins.build).toBe(free);
  });

  it('keeps a trainsOnPrompts checker pin routable', () => {
    vi.stubEnv('OPENCODE_API_KEY', 'test-key');
    const result = applyRepoConfig(defaultModelsConfig, { version: 2, models: { pins: { checker: free } } });
    expect(new ModelRegistry(result).getAvailableModelsForTier('checker', false, true)).toEqual([free]);
  });
});
