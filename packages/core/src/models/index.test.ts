import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { loadModelsConfig } from '../config/index.js';
import { diagnoseModels, isCommandAvailable, ModelRegistry, resolveModelOverrides } from './index.js';

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

  it('excludes the quarantined command-agent spike from local worker routing unless experimental is allowed', () => {
    const registry = new ModelRegistry(loadModelsConfig());
    expect(registry.getAvailableModelsForTier('worker', false, false, true)).not.toContain('codex-ollama-qwen3.5:9b');
    expect(registry.getAvailableModelsForTier('worker', false, true, true)).toContain('codex-ollama-qwen3.5:9b');
  });

  it('reports experimental status per model', () => {
    const registry = new ModelRegistry(config);
    expect(registry.isExperimental('exp-model')).toBe(true);
    expect(registry.isExperimental('real-model')).toBe(false);
    expect(registry.isExperimental('missing')).toBe(false);
  });

  it('returns false/[] for missing models across the boolean and lookup guards', () => {
    const registry = new ModelRegistry(config);
    expect(registry.getTiers('missing-model')).toEqual([]);
    expect(registry.isEnvAvailable('missing-model')).toBe(false);
    expect(registry.isCodexModel('missing-model')).toBe(false);
    expect(registry.isLocalOnlyModel('missing-model')).toBe(false);
    expect(registry.isAvailable('missing-model')).toBe(false);
  });

  it('returns [] for a tier with no configured models', () => {
    const registry = new ModelRegistry(config);
    expect(registry.getModelsInTier('missing-tier')).toEqual([]);
  });

  it('resolves an array tier value to itself instead of wrapping it', () => {
    const arrayTierConfig: ModelsConfig = {
      ...config,
      models: {
        ...config.models,
        'multi-tier-model': {
          provider: 'custom',
          tier: ['boss', 'worker'],
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
    };
    const registry = new ModelRegistry(arrayTierConfig);
    expect(registry.getTiers('multi-tier-model')).toEqual(['boss', 'worker']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('checks a non-null envKey against the environment', () => {
    const envConfig: ModelsConfig = {
      ...config,
      models: {
        ...config.models,
        'keyed-model': {
          provider: 'anthropic',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: 'SOME_TEST_ENV_KEY_XYZ',
        },
      },
    };
    const registry = new ModelRegistry(envConfig);

    vi.stubEnv('SOME_TEST_ENV_KEY_XYZ', '');
    expect(registry.isEnvAvailable('keyed-model')).toBe(false);

    vi.stubEnv('SOME_TEST_ENV_KEY_XYZ', '1');
    expect(registry.isEnvAvailable('keyed-model')).toBe(true);
  });

  it('excludes a byok model without a set env key while keeping free models available', () => {
    const byokConfig: ModelsConfig = {
      ...config,
      models: {
        ...config.models,
        'byok-model': {
          provider: 'anthropic',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: 'BYOK_TEST_ENV_KEY_XYZ',
        },
      },
      tiers: { boss: ['real-model', 'byok-model'] },
    };
    vi.stubEnv('BYOK_TEST_ENV_KEY_XYZ', '');
    const registry = new ModelRegistry(byokConfig);
    expect(registry.getAvailableModelsForTier('boss', true)).toEqual(['real-model']);
  });
});

describe('estimateCost', () => {
  it('computes cost from per-mtok input/output rates', () => {
    const costConfig: ModelsConfig = {
      ...config,
      models: {
        ...config.models,
        'priced-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 3,
          costPerMtokOutput: 15,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
    };
    const registry = new ModelRegistry(costConfig);
    expect(registry.estimateCost('priced-model', 1_000_000, 500_000)).toBeCloseTo(3 + 7.5);
  });

  it('returns 0 for an unknown model', () => {
    const registry = new ModelRegistry(config);
    expect(registry.estimateCost('missing-model', 1000, 1000)).toBe(0);
  });
});

describe('isCommandAvailable', () => {
  it('returns true for a real command and false for a nonexistent one', () => {
    expect(isCommandAvailable('sh')).toBe(true);
    expect(isCommandAvailable('definitely-not-a-cmd-xyz123')).toBe(false);
  });
});

const harnessConfig: ModelsConfig = {
  version: 1,
  models: {
    'declared-harness-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'codex-cli',
    },
    'codex-ollama-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
    'codex-model': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
    'ollama-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
    'default-model': {
      provider: 'anthropic',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['declared-harness-model', 'codex-ollama-model', 'codex-model', 'ollama-model', 'default-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

describe('getHarnessId', () => {
  const registry = new ModelRegistry(harnessConfig);

  it('prefers the declared harness over inference', () => {
    expect(registry.getHarnessId('declared-harness-model')).toBe('codex-cli');
  });

  it('infers ollama-command-agent for codex+ollama models', () => {
    expect(registry.getHarnessId('codex-ollama-model')).toBe('ollama-command-agent');
  });

  it('infers codex-cli for codex models', () => {
    expect(registry.getHarnessId('codex-model')).toBe('codex-cli');
  });

  it('infers ollama-http for ollama models', () => {
    expect(registry.getHarnessId('ollama-model')).toBe('ollama-http');
  });

  it('defaults to claude-cli', () => {
    expect(registry.getHarnessId('default-model')).toBe('claude-cli');
  });

  it('returns undefined for an unknown model', () => {
    expect(registry.getHarnessId('missing-model')).toBeUndefined();
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
    'opencode-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
    'declared-codex-over-ollama-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
      harness: 'codex-cli',
    },
    'ollama-http-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'ollama-http',
      providerModel: 'qwen2.5-coder:14b',
    },
    'ollama-agentic-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'ollama-agentic',
      codex: true,
      providerModel: 'qwen3.5:9b',
    },
  },
  tiers: {
    boss: ['anthropic-model'],
    worker: [
      'codex-model',
      'ollama-model',
      'ollama-codex-model',
      'ollama-cloud-model',
      'deepseek-model',
      'experimental-model',
      'opencode-model',
      'declared-codex-over-ollama-model',
      'ollama-http-model',
      'ollama-agentic-model',
    ],
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
    const d = diagnosisFor(
      'ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'claude',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  it('marks an ollama model reachable through native ollama when ollama is present', () => {
    const d = diagnosisFor(
      'ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        ollamaModelPresent: (model) => model === 'qwen2.5-coder:14b',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native)');
  });

  it('marks a codex-tagged ollama model reachable through native ollama without codex CLI', () => {
    const d = diagnosisFor(
      'ollama-codex-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        ollamaModelPresent: (model) => model === 'qwen3.5:9b',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native command agent)');
  });

  it('marks an ollama model unreachable when the native model is missing', () => {
    const d = diagnosisFor(
      'ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        ollamaModelPresent: () => false,
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('qwen2.5-coder:14b not found in ollama list');
  });

  it('excludes non-local models in local-only mode', () => {
    const registry = new ModelRegistry(doctorConfig);
    const diagnoses = diagnoseModels(
      registry,
      {
        commandAvailable: () => true,
        envPresent: () => true,
        ollamaModelPresent: () => true,
      },
      true,
      true,
    );

    expect(diagnoses.find((d) => d.model === 'ollama-model')?.reachable).toBe(true);
    expect(diagnoses.find((d) => d.model === 'ollama-cloud-model')?.reason).toBe('excluded by FACTORY_LOCAL_ONLY=1');
    expect(diagnoses.find((d) => d.model === 'codex-model')?.reason).toBe('excluded by FACTORY_LOCAL_ONLY=1');
  });

  it('marks a non-anthropic env-keyed model unreachable when the key is missing, naming the key', () => {
    const d = diagnosisFor(
      'deepseek-model',
      {
        commandAvailable: (cmd) => cmd === 'claude',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('DEEPSEEK_API_KEY not set');
  });

  it('marks a non-anthropic env-keyed model reachable when the key is present', () => {
    const d = diagnosisFor(
      'deepseek-model',
      {
        commandAvailable: (cmd) => cmd === 'claude',
        envPresent: (key) => key === 'DEEPSEEK_API_KEY',
      },
      true,
    );
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
    const d = diagnosisFor(
      'experimental-model',
      {
        commandAvailable: () => true,
        envPresent: () => true,
      },
      true,
    );
    expect(d.reachable).toBe(true);
  });

  it('marks an opencode model unreachable when opencode is missing even with claude present', () => {
    const d = diagnosisFor(
      'opencode-model',
      {
        commandAvailable: (cmd) => cmd === 'claude',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('opencode CLI not found on PATH');
  });

  it('marks an opencode model reachable when opencode is present', () => {
    const d = diagnosisFor(
      'opencode-model',
      {
        commandAvailable: (cmd) => cmd === 'opencode',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI)');
  });

  it('probes by declared harness even when legacy fields say ollama: reachable via codex CLI', () => {
    const d = diagnosisFor(
      'declared-codex-over-ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'codex',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (codex CLI)');
  });

  it('probes by declared harness even when legacy fields say ollama: unreachable when codex CLI is missing', () => {
    const d = diagnosisFor(
      'declared-codex-over-ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('codex CLI not found on PATH');
  });

  it('marks a declared ollama-http model unreachable when ollama is missing and no base URL is set', () => {
    const d = diagnosisFor(
      'ollama-http-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  it('marks a declared ollama-http model reachable via native ollama', () => {
    const d = diagnosisFor(
      'ollama-http-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        ollamaModelPresent: (model) => model === 'qwen2.5-coder:14b',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native)');
  });

  it('marks a declared ollama-agentic model reachable via native ollama', () => {
    const d = diagnosisFor(
      'ollama-agentic-model',
      {
        commandAvailable: (cmd) => cmd === 'ollama',
        ollamaModelPresent: (model) => model === 'qwen3.5:9b',
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama agentic)');
  });

  it('marks a declared ollama-agentic model unreachable when ollama is missing', () => {
    const d = diagnosisFor(
      'ollama-agentic-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  it('marks an ollama-agentic model reachable via a remote OLLAMA_BASE_URL without a local CLI', () => {
    const d = diagnosisFor(
      'ollama-agentic-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
        ollamaBaseUrl: () => 'http://gpu-box:11434',
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama agentic via http://gpu-box:11434)');
  });

  it('marks an ollama-http model reachable via a remote OLLAMA_BASE_URL without a local CLI', () => {
    const d = diagnosisFor(
      'ollama-http-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
        ollamaBaseUrl: () => 'http://gpu-box:11434',
      },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (ollama native via http://gpu-box:11434)');
  });

  it('treats a loopback OLLAMA_BASE_URL as local and still requires the ollama CLI', () => {
    const d = diagnosisFor(
      'ollama-agentic-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
        ollamaBaseUrl: () => 'http://127.0.0.1:11434',
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  it('falls back to local probing for an unparseable OLLAMA_BASE_URL', () => {
    const d = diagnosisFor(
      'ollama-agentic-model',
      {
        commandAvailable: () => false,
        envPresent: () => false,
        ollamaBaseUrl: () => 'not a url',
      },
      true,
    );
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('ollama not found on PATH');
  });

  describe('default OLLAMA_BASE_URL probe', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reads OLLAMA_BASE_URL from the environment when no probe override is given', () => {
      vi.stubEnv('OLLAMA_BASE_URL', 'http://gpu-box:11434');
      const registry = new ModelRegistry(doctorConfig);
      const d = diagnoseModels(
        registry,
        {
          commandAvailable: () => false,
          envPresent: () => false,
        },
        true,
      ).find((x) => x.model === 'ollama-agentic-model')!;
      expect(d.reachable).toBe(true);
      expect(d.reason).toBe('ok (ollama agentic via http://gpu-box:11434)');
    });
  });

  it('marks a self-auth model reachable via API key when the env key is present', () => {
    const d = diagnosisFor('anthropic-model', { commandAvailable: (cmd) => cmd === 'claude', envPresent: () => true });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI)');
  });

  it('falls back to the harness default env key for a self-auth model with no envKey configured', () => {
    const noKeyConfig: ModelsConfig = {
      ...doctorConfig,
      models: {
        ...doctorConfig.models,
        'anthropic-no-key-model': {
          provider: 'anthropic',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
      tiers: { ...doctorConfig.tiers, boss: [...doctorConfig.tiers.boss, 'anthropic-no-key-model'] },
    };
    const registry = new ModelRegistry(noKeyConfig);
    const d = diagnoseModels(
      registry,
      { commandAvailable: (cmd) => cmd === 'claude', envPresent: (key) => key === 'ANTHROPIC_API_KEY' },
      true,
    ).find((x) => x.model === 'anthropic-no-key-model')!;
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI)');
  });

  it('falls back to isCommandAvailable and real env presence when no probes are given', () => {
    const registry = new ModelRegistry(doctorConfig);
    const diagnoses = diagnoseModels(registry, {}, true);
    const d = diagnoses.find((x) => x.model === 'anthropic-model')!;
    expect(typeof d.reachable).toBe('boolean');
    expect(typeof d.reason).toBe('string');
  });

  it('marks a model with an unknown declared harness unreachable, naming the known harnesses', () => {
    const unknownHarnessConfig: ModelsConfig = {
      ...doctorConfig,
      models: {
        ...doctorConfig.models,
        'bogus-harness-model': {
          provider: 'custom',
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          harness: 'bogus',
        },
      },
      tiers: {
        ...doctorConfig.tiers,
        worker: [...doctorConfig.tiers.worker, 'bogus-harness-model'],
      },
    };
    const registry = new ModelRegistry(unknownHarnessConfig);
    const d = diagnoseModels(registry, { commandAvailable: () => true, envPresent: () => true }, true).find(
      (x) => x.model === 'bogus-harness-model',
    )!;
    expect(d.reachable).toBe(false);
    expect(d.reason).toMatch(/^unknown harness 'bogus'/);
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
