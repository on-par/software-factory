import { describe, expect, it } from 'vitest';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry, diagnoseModels, resolveModelOverrides } from './index.js';

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

const doctorConfig: ModelsConfig = {
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: 'OPENAI_API_KEY',
      codex: true,
    },
    'anthropic-model': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: 'ANTHROPIC_API_KEY',
    },
    'ollama-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      providerModel: 'qwen2.5-coder:14b',
    },
    'ollama-codex-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      providerModel: 'qwen3.5:9b',
      codex: true,
    },
    'ollama-cloud-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      providerModel: 'glm-5.2:cloud',
    },
    'deepseek-model': {
      provider: 'deepseek',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: 'DEEPSEEK_API_KEY',
    },
    'experimental-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      experimental: true,
    },
  },
  tiers: {
    boss: ['anthropic-model'],
    worker: ['codex-model', 'ollama-model', 'ollama-codex-model', 'ollama-cloud-model', 'deepseek-model', 'experimental-model'],
  },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

function diagnosisFor(model: string, probes: Parameters<typeof diagnoseModels>[1], allowExperimental = false) {
  const registry = new ModelRegistry(doctorConfig);
  return diagnoseModels(registry, probes, allowExperimental).find((d) => d.model === model)!;
}

describe('diagnoseModels', () => {
  it('marks a codex model unreachable when the codex CLI is missing', () => {
    const d = diagnosisFor('codex-model', { commandAvailable: () => false, envPresent: () => false });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('codex CLI not found on PATH');
  });

  it('marks a codex model reachable when codex is present, even without the env key', () => {
    const d = diagnosisFor('codex-model', {
      commandAvailable: (cmd) => cmd === 'codex',
      envPresent: () => false,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (codex CLI)');
  });

  it('marks an anthropic model unreachable when the claude CLI is missing', () => {
    const d = diagnosisFor('anthropic-model', { commandAvailable: () => false, envPresent: () => false });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('claude CLI not found on PATH');
  });

  it('marks an anthropic model reachable via claude CLI auth when the env key is absent', () => {
    const d = diagnosisFor('anthropic-model', {
      commandAvailable: (cmd) => cmd === 'claude',
      envPresent: () => false,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI auth; ANTHROPIC_API_KEY not set)');
  });

  it('marks an ollama model unreachable when ollama is missing, even with claude present', () => {
    const d = diagnosisFor('ollama-model', {
      commandAvailable: (cmd) => cmd === 'claude',
      envPresent: () => false,
    }, true);
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  it('marks an ollama model reachable through native ollama when ollama is present', () => {
    const d = diagnosisFor('ollama-model', {
      commandAvailable: (cmd) => cmd === 'ollama',
      ollamaModelPresent: (model) => model === 'qwen2.5-coder:14b',
      envPresent: () => false,
    }, true);
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native)');
  });

  it('marks a codex-tagged ollama model reachable through native ollama without codex CLI', () => {
    const d = diagnosisFor('ollama-codex-model', {
      commandAvailable: (cmd) => cmd === 'ollama',
      ollamaModelPresent: (model) => model === 'qwen3.5:9b',
      envPresent: () => false,
    }, true);
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native command agent)');
  });

  it('marks an ollama model unreachable when the native model is missing', () => {
    const d = diagnosisFor('ollama-model', {
      commandAvailable: (cmd) => cmd === 'ollama',
      ollamaModelPresent: () => false,
      envPresent: () => false,
    }, true);
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('qwen2.5-coder:14b not found in ollama list');
  });

  it('excludes non-local models in local-only mode', () => {
    const registry = new ModelRegistry(doctorConfig);
    const diagnoses = diagnoseModels(registry, {
      commandAvailable: () => true,
      envPresent: () => true,
      ollamaModelPresent: () => true,
    }, true, true);

    expect(diagnoses.find(d => d.model === 'ollama-model')?.reachable).toBe(true);
    expect(diagnoses.find(d => d.model === 'ollama-cloud-model')?.reason).toBe('excluded by FACTORY_LOCAL_ONLY=1');
    expect(diagnoses.find(d => d.model === 'codex-model')?.reason).toBe('excluded by FACTORY_LOCAL_ONLY=1');
  });

  it('marks a non-anthropic env-keyed model unreachable when the key is missing, naming the key', () => {
    const d = diagnosisFor('deepseek-model', {
      commandAvailable: (cmd) => cmd === 'claude',
      envPresent: () => false,
    }, true);
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('DEEPSEEK_API_KEY not set');
  });

  it('marks a non-anthropic env-keyed model reachable when the key is present', () => {
    const d = diagnosisFor('deepseek-model', {
      commandAvailable: (cmd) => cmd === 'claude',
      envPresent: (key) => key === 'DEEPSEEK_API_KEY',
    }, true);
    expect(d.reachable).toBe(true);
  });

  it('gates an experimental model by default, mentioning the opt-in env var', () => {
    const d = diagnosisFor('experimental-model', {
      commandAvailable: () => true,
      envPresent: () => true,
    });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('experimental — set FACTORY_EXPERIMENTAL=1 to enable');
  });

  it('probes an experimental model normally when opted in', () => {
    const d = diagnosisFor('experimental-model', {
      commandAvailable: () => true,
      envPresent: () => true,
    }, true);
    expect(d.reachable).toBe(true);
  });
});

const overridesConfig: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('resolveModelOverrides', () => {
  const registry = new ModelRegistry(overridesConfig);

  it('returns undefined for both fields when neither var is set', () => {
    expect(resolveModelOverrides(registry, {})).toEqual({ plan: undefined, build: undefined });
  });

  it('resolves FACTORY_PLAN_MODEL to plan', () => {
    expect(resolveModelOverrides(registry, { FACTORY_PLAN_MODEL: 'stub-model' })).toEqual({
      plan: 'stub-model',
      build: undefined,
    });
  });

  it('resolves FACTORY_BUILD_MODEL to build', () => {
    expect(resolveModelOverrides(registry, { FACTORY_BUILD_MODEL: 'stub-model' })).toEqual({
      plan: undefined,
      build: 'stub-model',
    });
  });

  it('throws naming FACTORY_PLAN_MODEL and the unknown model', () => {
    expect(() => resolveModelOverrides(registry, { FACTORY_PLAN_MODEL: 'no-such-model' })).toThrow(
      /FACTORY_PLAN_MODEL.*no-such-model/s,
    );
  });

  it('throws naming FACTORY_BUILD_MODEL and the unknown model', () => {
    expect(() => resolveModelOverrides(registry, { FACTORY_BUILD_MODEL: 'no-such-model' })).toThrow(
      /FACTORY_BUILD_MODEL.*no-such-model/s,
    );
  });

  it('treats empty and whitespace-only values as unset', () => {
    expect(resolveModelOverrides(registry, { FACTORY_PLAN_MODEL: '', FACTORY_BUILD_MODEL: '   ' })).toEqual({
      plan: undefined,
      build: undefined,
    });
  });
});
