import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from './index.js';
import { applyRepoConfig } from './repo.js';

type ModelDef = ModelsConfig['models'][string];

function baseModel(overrides: Partial<ModelDef> = {}): ModelDef {
  return {
    provider: 'anthropic',
    tier: 'worker',
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
  models: { 'claude-model': baseModel({ tier: 'boss' }) },
  tiers: { boss: ['claude-model'], worker: [], checker: [], triage: [] },
  failover: { triggers: ['error'], maxRetries: 2, cooldownMs: 0, escalateAfterTierExhausted: true },
  routingRules: {},
};

describe('repo models.registry DeepSeek policy (#2895)', () => {
  const load = (def: ModelDef) => applyRepoConfig(models, { version: 2, models: { registry: { ds: def } } });

  function messageOf(def: ModelDef): string {
    try {
      load(def);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected applyRepoConfig to throw');
  }

  it('refuses a native deepseek/ provider on opencode', () => {
    const message = messageOf(baseModel({ harness: 'opencode', providerModel: 'deepseek/deepseek-chat' }));
    expect(message).toContain('models.registry.ds');
    expect(message).toContain('ADR-0163');
    expect(message).toContain('OpenRouter');
    expect(message).toContain('OpenCode Go');
  });

  it('refuses an api.deepseek.com providerOptions URL', () => {
    const message = messageOf(
      baseModel({
        harness: 'opencode',
        providerModel: 'openrouter/x',
        providerOptions: { baseURL: 'https://api.deepseek.com/v1' },
      }),
    );
    expect(message).toContain('api.deepseek.com');
    expect(message).toContain('OpenRouter');
    expect(message).toContain('OpenCode Go');
  });

  it('refuses envKey DEEPSEEK_API_KEY', () => {
    const message = messageOf(baseModel({ envKey: 'DEEPSEEK_API_KEY' }));
    expect(message).toContain('DEEPSEEK_API_KEY');
    expect(message).toContain('ADR-0163');
  });

  it('accepts an openrouter/ DeepSeek model', () => {
    const result = load(baseModel({ harness: 'opencode', providerModel: 'openrouter/deepseek/deepseek-v4-flash' }));
    expect(result.models).toHaveProperty('ds');
  });
});
