import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from './index.js';
import { applyRepoConfig } from './repo.js';

type ModelDef = ModelsConfig['models'][string];

const baseModel = (over: Partial<ModelDef> = {}): ModelDef => ({
  provider: 'anthropic',
  tier: 'worker',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
  ...over,
});

const models: ModelsConfig = {
  version: 1,
  models: { 'claude-model': baseModel({ tier: 'boss' }) },
  tiers: { boss: ['claude-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('repo models.registry direct DeepSeek (ADR-0163)', () => {
  const repoWith = (overrides: Partial<ModelDef>) =>
    ({
      version: 2,
      models: { registry: { 'ds-model': baseModel({ provider: 'custom', tier: 'worker', ...overrides }) } },
    }) as NonNullable<Parameters<typeof applyRepoConfig>[1]>;

  it('refuses a native opencode deepseek/ providerModel', () => {
    const repo = repoWith({ harness: 'opencode', providerModel: 'deepseek/deepseek-chat' });
    expect(() => applyRepoConfig(models, repo)).toThrow(/ADR-0163/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/OpenRouter/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/OpenCode Go/);
  });

  it('refuses a providerOptions baseURL on api.deepseek.com', () => {
    const repo = repoWith({ harness: 'opencode', providerOptions: { baseURL: 'https://api.deepseek.com/v1' } });
    expect(() => applyRepoConfig(models, repo)).toThrow(/api\.deepseek\.com/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/OpenRouter/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/OpenCode Go/);
  });

  it('refuses envKey DEEPSEEK_API_KEY', () => {
    const repo = repoWith({ harness: 'opencode', envKey: 'DEEPSEEK_API_KEY' });
    expect(() => applyRepoConfig(models, repo)).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/ADR-0163/);
  });

  it('accepts an openrouter/ deepseek providerModel', () => {
    const repo = repoWith({ harness: 'opencode', providerModel: 'openrouter/deepseek/deepseek-v4-flash' });
    expect(applyRepoConfig(models, repo).models['ds-model']).toBeDefined();
  });
});
