import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from './index.js';

const config: ModelsConfig = {
  ...defaultModelsConfig,
  models: {
    'openai-claude-cli-model': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: 'OPENAI_API_KEY',
      harness: 'claude-cli',
    },
  },
  tiers: { boss: [], worker: ['openai-claude-cli-model'], checker: [], triage: [] },
};

function diagnosisFor(probes: Parameters<typeof diagnoseModels>[1]) {
  const d = diagnoseModels(new ModelRegistry(config), probes).find((x) => x.model === 'openai-claude-cli-model');
  if (!d) throw new Error('model missing from diagnoses');
  return d;
}

describe('diagnoseModels unsupported claude-cli providers (#2896)', () => {
  it('marks a claude-cli model with a non-anthropic provider unsupported even when its env key is set', () => {
    const d = diagnosisFor({
      commandAvailable: (c) => c === 'claude',
      envPresent: () => true,
      claudeLoggedIn: () => true,
    });
    expect(d.reachable).toBe(false);
    expect(d.unverified).toBe(false);
    expect(d.reason).toMatch(/^unsupported: the claude CLI serves only Anthropic models/);
  });

  it('reports unsupported rather than a missing claude CLI', () => {
    const d = diagnosisFor({ commandAvailable: () => false, envPresent: () => true });
    expect(d.reachable).toBe(false);
    expect(d.reason).toMatch(/^unsupported: the claude CLI serves only Anthropic models/);
  });

  it('keeps claude-sonnet-5 from the packaged defaults at ok (claude CLI) when ANTHROPIC_API_KEY is set', () => {
    const d = diagnoseModels(new ModelRegistry(defaultModelsConfig), {
      envPresent: (k) => k === 'ANTHROPIC_API_KEY',
      commandAvailable: (c) => c === 'claude',
      claudeLoggedIn: () => false,
    }).find((x) => x.model === 'claude-sonnet-5');
    expect(d?.reason).toBe('ok (claude CLI)');
    expect(d?.reachable).toBe(true);
  });
});
