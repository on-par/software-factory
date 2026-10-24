import { defaultModelsConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { assertTierMayRoute } from './repo-tier-guard.js';
import { applyRepoConfig, resolveEffectiveModelPins } from './repo.js';

const free = 'my-free-model';
const freeRegistry = {
  [free]: {
    provider: 'custom',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    harness: 'opencode',
    providerModel: 'my-provider/free',
    trainsOnPrompts: true,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trainsOnPrompts models (#2899)', () => {
  it('throws naming a trainsOnPrompts model in a repo tier and says to pin it instead', () => {
    const repo = { version: 2, models: { registry: freeRegistry }, tiers: { worker: [free] } } as NonNullable<
      Parameters<typeof applyRepoConfig>[1]
    >;
    expect(() => applyRepoConfig(defaultModelsConfig, repo)).toThrow(/tier 'worker'.*my-free-model.*pin it instead/is);
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

  it('names the config label it is given', () => {
    const def = freeRegistry[free] as Parameters<typeof assertTierMayRoute>[2];
    expect(() => assertTierMayRoute('worker', free, def, '.factory/config.yaml')).toThrow(
      /^\.factory\/config\.yaml: tier/,
    );
    expect(() => assertTierMayRoute('worker', free, def)).toThrow(/^\.factory\/config\.json: tier/);
  });

  it('still fires the unknown-model error first for an unknown id', () => {
    expect(() => applyRepoConfig(defaultModelsConfig, { version: 2, tiers: { worker: ['nope'] } })).toThrow(
      /unknown model 'nope'/,
    );
  });

  it('resolves a build pin to a trainsOnPrompts model', () => {
    const repo = { version: 2, models: { registry: freeRegistry, pins: { build: free } } } as NonNullable<
      Parameters<typeof applyRepoConfig>[1]
    >;
    const pins = resolveEffectiveModelPins(new ModelRegistry(applyRepoConfig(defaultModelsConfig, repo)), repo, {});
    expect(pins.build).toBe(free);
  });

  it('keeps a trainsOnPrompts checker pin routable', () => {
    vi.stubEnv('OPENCODE_API_KEY', 'test-key');
    const result = applyRepoConfig(defaultModelsConfig, {
      version: 2,
      models: { registry: freeRegistry, pins: { checker: free } },
    } as NonNullable<Parameters<typeof applyRepoConfig>[1]>);
    expect(new ModelRegistry(result).getAvailableModelsForTier('checker', false, true)).toEqual([free]);
  });
});
