import { describe, expect, it } from 'vitest';

import { defaultModelsConfig } from './defaults.js';

describe('claude-haiku-5-5 registry entry', () => {
  it('registers claude-haiku-5-5 as a routable claude-cli model in the triage_cheap tier (#783)', () => {
    const haiku = defaultModelsConfig.models['claude-haiku-5-5'];
    expect(haiku).toMatchObject({
      provider: 'anthropic',
      harness: 'claude-cli',
      claudeFlag: 'claude-haiku-5-5',
      costPerMtokInput: 0.1,
      costPerMtokOutput: 0.5,
      contextWindow: 200000,
      envKey: null,
    });
    expect(haiku?.experimental).toBeUndefined();
    const tier = defaultModelsConfig.tiers.triage_cheap ?? [];
    expect(tier).toEqual(['qwen2.5-coder:14b', 'claude-haiku-5-5', 'claude-sonnet-5', 'glm-5.2', 'gpt-5.6-luna-high']);
    expect(tier.indexOf('claude-haiku-5-5')).toBe(tier.indexOf('claude-sonnet-5') - 1);
    for (const [name, ids] of Object.entries(defaultModelsConfig.tiers)) {
      if (name !== 'triage_cheap') expect(ids, name).not.toContain('claude-haiku-5-5');
    }
  });
});
