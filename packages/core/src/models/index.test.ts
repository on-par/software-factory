import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { loadModelsConfig } from '../config/index.js';
import {
  diagnoseModels,
  isCommandAvailable,
  isHarnessCliPresent,
  ModelRegistry,
  probeDeclaredHarnesses,
  resolveModelOverrides,
  runHarnessProbe,
} from './index.js';

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

describe('ModelRegistry harness declarations', () => {
  const declaration = {
    command: 'my-agent {model}',
    prompt: 'stdin',
    output: 'stdout',
    agentic: true,
    usage: 'none',
  } as const;
  const withHarnesses = (harnesses: ModelsConfig['harnesses']) => new ModelRegistry({ ...config, harnesses });

  it('returns a declared harness and treats it as agentic per its declaration', () => {
    const registry = withHarnesses({ 'my-agent': declaration, 'chat-only': { ...declaration, agentic: false } });
    expect(registry.getHarnessDeclaration('my-agent')).toEqual(declaration);
    expect(registry.isAgenticHarnessId('my-agent')).toBe(true);
    expect(registry.isAgenticHarnessId('chat-only')).toBe(false);
  });

  it('returns undefined for undeclared ids, including prototype keys', () => {
    const registry = withHarnesses({ 'my-agent': declaration });
    expect(registry.getHarnessDeclaration('nope')).toBeUndefined();
    expect(registry.getHarnessDeclaration('toString')).toBeUndefined();
    expect(registry.isAgenticHarnessId('nope')).toBe(false);
  });

  it('lists declared harness ids', () => {
    expect(withHarnesses({ 'my-agent': declaration, other: declaration }).listDeclaredHarnesses()).toEqual([
      'my-agent',
      'other',
    ]);
    expect(new ModelRegistry(config).listDeclaredHarnesses()).toEqual([]);
  });

  it('tolerates a config with harnesses undefined', () => {
    const registry = new ModelRegistry(config);
    expect(registry.getHarnessDeclaration('my-agent')).toBeUndefined();
    expect(registry.isAgenticHarnessId('my-agent')).toBe(false);
  });

  it('ridesCommandRoute: declared agentic harnesses and pi only (#2909)', () => {
    const registry = withHarnesses({ 'my-agent': declaration, 'chat-only': { ...declaration, agentic: false } });
    expect(registry.ridesCommandRoute('pi')).toBe(true);
    expect(registry.ridesCommandRoute('my-agent')).toBe(true);
    for (const id of ['chat-only', 'ollama-http', 'ollama-agentic', 'claude-cli', 'unknown', '']) {
      expect(registry.ridesCommandRoute(id)).toBe(false);
    }
  });

  it('keeps built-in agentic semantics', () => {
    const registry = new ModelRegistry(config);
    expect(registry.isAgenticHarnessId('claude-cli')).toBe(true);
    expect(registry.isAgenticHarnessId('ollama-http')).toBe(false);
  });
});

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

  it('returns null (unpriced) for an unknown model', () => {
    const registry = new ModelRegistry(config);
    expect(registry.estimateCost('missing-model', 1000, 1000)).toBeNull();
  });

  it('returns 0 for a registered model priced at 0', () => {
    const registry = new ModelRegistry({
      ...config,
      models: {
        ...config.models,
        'free-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
    });
    expect(registry.estimateCost('free-model', 1000, 1000)).toBe(0);
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
      harness: 'codex-cli',
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
      codexLoggedIn: () => true,
      envPresent: () => false,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (codex CLI)');
  });

  it('marks a codex model unreachable with a codex login reason when the CLI is installed but not logged in', () => {
    const d = diagnosisFor('codex-model', {
      commandAvailable: (c) => c === 'codex',
      envPresent: () => false,
      codexLoggedIn: () => false,
    });
    expect(d.reachable).toBe(false);
    expect(d.reason).toContain('`codex login`');
  });

  it('keeps a codex model reachable when the codex CLI is logged in (consults the login probe)', () => {
    const codexLoggedIn = vi.fn(() => true);
    const d = diagnosisFor('codex-model', {
      commandAvailable: (c) => c === 'codex',
      envPresent: () => false,
      codexLoggedIn,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (codex CLI)');
    expect(codexLoggedIn).toHaveBeenCalled();
  });

  it('does not consult the codex login probe when codex is missing from PATH', () => {
    const codexLoggedIn = vi.fn(() => true);
    const d = diagnosisFor('codex-model', { commandAvailable: () => false, envPresent: () => false, codexLoggedIn });
    expect(d.reason).toBe('codex CLI not found on PATH');
    expect(codexLoggedIn).not.toHaveBeenCalled();
  });

  it('calls the codex login probe at most once per diagnoseModels call', () => {
    const codexLoggedIn = vi.fn(() => true);
    diagnoseModels(
      new ModelRegistry(doctorConfig),
      { commandAvailable: (c) => c === 'codex', envPresent: () => false, codexLoggedIn },
      true,
    );
    expect(codexLoggedIn).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing codex login probe as not logged in', () => {
    const d = diagnosisFor('codex-model', {
      commandAvailable: (c) => c === 'codex',
      envPresent: () => false,
      codexLoggedIn: () => {
        throw new Error('boom');
      },
    });
    expect(d.reachable).toBe(false);
    expect(d.reason).toContain('`codex login`');
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
      claudeLoggedIn: () => true,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI auth; ANTHROPIC_API_KEY not set)');
  });

  const claudeOpusConfig = (): ModelsConfig => ({
    ...doctorConfig,
    models: {
      ...doctorConfig.models,
      'claude-opus-5': {
        provider: 'anthropic',
        tier: 'boss',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
    },
    tiers: { ...doctorConfig.tiers, boss: [...doctorConfig.tiers.boss, 'claude-opus-5'] },
  });
  const opusDiagnosis = (probes: Parameters<typeof diagnoseModels>[1]) =>
    diagnoseModels(new ModelRegistry(claudeOpusConfig()), probes, true).find((x) => x.model === 'claude-opus-5')!;

  it('marks a Claude model unreachable with a claude /login reason when the CLI is installed but not logged in', () => {
    const probes = {
      commandAvailable: (c: string) => c === 'claude',
      envPresent: () => false,
      claudeLoggedIn: () => false,
    };
    const d = diagnosisFor('anthropic-model', probes);
    expect(d.reachable).toBe(false);
    expect(d.reason).toContain('`claude /login`');
    expect(d.reason).toContain('ANTHROPIC_API_KEY');
    const opus = opusDiagnosis(probes);
    expect(opus.reachable).toBe(false);
    expect(opus.reason).toContain('`claude /login`');
  });

  it('keeps a Claude model reachable when the CLI is logged in and no API key is set', () => {
    const claudeLoggedIn = vi.fn(() => true);
    const d = opusDiagnosis({ commandAvailable: (c) => c === 'claude', envPresent: () => false, claudeLoggedIn });
    expect(d.reachable).toBe(true);
    expect(claudeLoggedIn).toHaveBeenCalled();
  });

  it('keeps a Claude model reachable via ANTHROPIC_API_KEY without consulting the login probe', () => {
    const claudeLoggedIn = vi.fn(() => false);
    const d = opusDiagnosis({ commandAvailable: (c) => c === 'claude', envPresent: () => true, claudeLoggedIn });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (claude CLI)');
    expect(claudeLoggedIn).not.toHaveBeenCalled();
  });

  it('calls the login probe at most once per diagnoseModels call', () => {
    const claudeLoggedIn = vi.fn(() => true);
    const ds = diagnoseModels(
      new ModelRegistry(claudeOpusConfig()),
      { commandAvailable: (c) => c === 'claude', envPresent: () => false, claudeLoggedIn },
      true,
    ).filter((x) => x.provider === 'anthropic');
    expect(ds.length).toBeGreaterThan(1);
    expect(claudeLoggedIn).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'darwin')(
    'marks Claude models unreachable for a stored login that expired with no refresh token (#2721)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'claude-2721-'));
      try {
        vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
        const write = (oauth: Record<string, unknown>) =>
          writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
        const probes = { commandAvailable: (c: string) => c === 'claude', envPresent: () => false };
        write({ accessToken: 'x', expiresAt: Date.now() - 3_600_000 });
        expect(opusDiagnosis(probes).reachable).toBe(false);
        write({ accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() - 3_600_000 });
        expect(opusDiagnosis(probes).reachable).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('marks Claude models unreachable when the last run hit local_auth with no login since (#2733)', () => {
    const localAuthFailure = vi.fn((a: 'claude' | 'codex') =>
      a === 'claude' ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null,
    );
    const ds = diagnoseModels(
      new ModelRegistry(claudeOpusConfig()),
      {
        commandAvailable: () => true,
        envPresent: () => true,
        claudeLoggedIn: () => true,
        codexLoggedIn: () => true,
        localAuthFailure,
      },
      true,
    );
    const opus = ds.find((x) => x.model === 'claude-opus-5')!;
    expect(opus.reachable).toBe(false);
    expect(opus.reason).toContain('re-run claude login');
    expect(localAuthFailure.mock.calls.filter(([a]) => a === 'claude')).toHaveLength(1);
  });

  it('marks Codex models unreachable when codex hit local_auth with no login since (#2733)', () => {
    const ds = diagnoseModels(
      new ModelRegistry(doctorConfig),
      {
        commandAvailable: () => true,
        envPresent: () => true,
        codexLoggedIn: () => true,
        localAuthFailure: (a) => (a === 'codex' ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null),
      },
      true,
    );
    const codex = ds.filter((d) => new ModelRegistry(doctorConfig).getHarnessId(d.model) === 'codex-cli');
    expect(codex.length).toBeGreaterThan(0);
    for (const d of codex) {
      expect(d.reachable).toBe(false);
      expect(d.reason).toContain('re-run codex login');
    }
  });

  it('treats a throwing local-auth probe as no failure (#2733)', () => {
    const d = opusDiagnosis({
      commandAvailable: (c) => c === 'claude',
      envPresent: () => false,
      claudeLoggedIn: () => true,
      localAuthFailure: () => {
        throw new Error('boom');
      },
    });
    expect(d.reachable).toBe(true);
  });

  it('treats a throwing login probe as not logged in', () => {
    const d = opusDiagnosis({
      commandAvailable: (c) => c === 'claude',
      envPresent: () => false,
      claudeLoggedIn: () => {
        throw new Error('boom');
      },
    });
    expect(d.reachable).toBe(false);
    expect(d.reason).toContain('`claude /login`');
  });

  describe('diagnoseModels unverified state', () => {
    const P = 'unverified — no auth evidence: ';

    it('reports a logged-out Claude model as unverified, not reachable', () => {
      const d = opusDiagnosis({
        commandAvailable: (c) => c === 'claude',
        envPresent: () => false,
        claudeLoggedIn: () => false,
      });
      expect(d.reachable).toBe(false);
      expect(d.unverified).toBe(true);
      expect(d.reason.startsWith(P)).toBe(true);
      expect(d.reason).toContain('`claude /login`');
    });

    it('reports a logged-out Codex model as unverified, not reachable', () => {
      const d = diagnosisFor('codex-model', {
        commandAvailable: (c) => c === 'codex',
        envPresent: () => false,
        codexLoggedIn: () => false,
      });
      expect(d.reachable).toBe(false);
      expect(d.unverified).toBe(true);
      expect(d.reason.startsWith(P)).toBe(true);
      expect(d.reason).toContain('codex login');
    });

    it('a throwing login probe is unverified', () => {
      const d = opusDiagnosis({
        commandAvailable: (c) => c === 'claude',
        envPresent: () => false,
        claudeLoggedIn: () => {
          throw new Error('boom');
        },
      });
      expect(d.unverified).toBe(true);
    });

    it('a logged-in Claude model is reachable and not unverified', () => {
      const probes = { commandAvailable: (c: string) => c === 'claude', claudeLoggedIn: () => true };
      expect(opusDiagnosis({ ...probes, envPresent: () => false })).toMatchObject({
        reachable: true,
        unverified: false,
      });
      expect(opusDiagnosis({ ...probes, claudeLoggedIn: () => false, envPresent: () => true })).toMatchObject({
        reachable: true,
        unverified: false,
      });
    });

    it('a logged-in Codex model is reachable and not unverified', () => {
      const d = diagnosisFor('codex-model', {
        commandAvailable: (c) => c === 'codex',
        envPresent: () => false,
        codexLoggedIn: () => true,
      });
      expect(d).toMatchObject({ reachable: true, unverified: false });
    });

    it('a missing CLI is unreachable, not unverified', () => {
      const d = opusDiagnosis({ commandAvailable: () => false, envPresent: () => false });
      expect(d).toMatchObject({ reachable: false, unverified: false });
    });
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
        codexLoggedIn: () => true,
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

  it('marks a non-anthropic model on the default claude-cli harness unsupported whether or not its key is set', () => {
    for (const keySet of [false, true]) {
      const d = diagnosisFor(
        'deepseek-model',
        {
          commandAvailable: (cmd) => cmd === 'claude',
          envPresent: () => keySet,
        },
        true,
      );
      expect(d.reachable).toBe(false);
      expect(d.reason).toMatch(/^unsupported: the claude CLI serves only Anthropic models/);
    }
  });

  it('gates an experimental model by default, mentioning the opt-in env var', () => {
    const d = diagnosisFor('experimental-model', {
      commandAvailable: () => true,
      codexLoggedIn: () => true,
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
        codexLoggedIn: () => true,
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

  it('marks an opencode model with an envKey reachable via CLI login when the key is unset', () => {
    const registry = new ModelRegistry({
      ...doctorConfig,
      models: { 'oc-keyed': { ...doctorConfig.models['opencode-model'], envKey: 'OPENCODE_API_KEY' } },
    });
    const [d] = diagnoseModels(
      registry,
      { commandAvailable: (cmd) => cmd === 'opencode', envPresent: () => false, opencodeLoggedIn: () => true },
      true,
    );
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI auth; OPENCODE_API_KEY not set)');
  });

  it('probes by declared harness even when legacy fields say ollama: reachable via codex CLI', () => {
    const d = diagnosisFor(
      'declared-codex-over-ollama-model',
      {
        commandAvailable: (cmd) => cmd === 'codex',
        codexLoggedIn: () => true,
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
    const d = diagnosisFor('anthropic-model', {
      commandAvailable: (cmd) => cmd === 'claude',
      envPresent: () => true,
      claudeLoggedIn: () => false,
    });
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
      {
        commandAvailable: (cmd) => cmd === 'claude',
        envPresent: (key) => key === 'ANTHROPIC_API_KEY',
        claudeLoggedIn: () => false,
      },
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
    const d = diagnoseModels(
      registry,
      { commandAvailable: () => true, envPresent: () => true, codexLoggedIn: () => true },
      true,
    ).find((x) => x.model === 'bogus-harness-model')!;
    expect(d.reachable).toBe(false);
    expect(d.reason).toMatch(/^unknown harness 'bogus'/);
  });
});

describe('diagnoseModels declared harnesses', () => {
  const declared = (probe?: string): ModelsConfig => {
    const model = (harness: string) => ({
      provider: 'custom',
      tier: 'worker' as const,
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness,
    });
    return {
      ...doctorConfig,
      models: { 'agent-a': model('my-agent'), 'agent-b': model('my-agent') },
      tiers: { ...doctorConfig.tiers, worker: ['agent-a', 'agent-b'] },
      harnesses: {
        'my-agent': {
          command: 'my-agent {model}',
          prompt: 'stdin',
          output: 'stdout',
          agentic: true,
          usage: 'none',
          probe,
        },
      },
    } as ModelsConfig;
  };
  const diagnose = (cfg: ModelsConfig, harnessProbe: (cmd: string) => string | null) =>
    diagnoseModels(new ModelRegistry(cfg), { harnessProbe }, true).find((x) => x.model === 'agent-a')!;

  it('marks a model reachable when the declared probe passes', () => {
    const d = diagnose(declared('my-agent --version'), () => null);
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe("ok (harness 'my-agent' probe passed)");
  });

  it('marks a model unreachable with the probe failure when the declared probe fails', () => {
    const d = diagnose(declared('my-agent --version'), () => 'exit 127: my-agent: command not found');
    expect(d.reachable).toBe(false);
    expect(d.reason).toContain('probe failed');
    expect(d.reason).toContain('exit 127');
  });

  it('marks a model unverified when its declared harness has no probe', () => {
    const d = diagnose(declared(), () => null);
    expect(d.unverified).toBe(true);
    expect(d.reachable).toBe(false);
    expect(d.reason).toMatch(/^unverified — harness 'my-agent' has no probe configured/);
  });

  it('runs a shared probe once for several models', () => {
    const spy = vi.fn(() => null);
    diagnoseModels(new ModelRegistry(declared('my-agent --version')), { harnessProbe: spy }, true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing probe into unavailable', () => {
    const result = probeDeclaredHarnesses(new ModelRegistry(declared('x')), () => {
      throw new Error('spawn failed');
    });
    expect(result).toEqual([{ harness: 'my-agent', probe: 'x', status: 'unavailable', detail: 'spawn failed' }]);
  });

  it('returns no probes when no harnesses are declared', () => {
    expect(probeDeclaredHarnesses(new ModelRegistry(doctorConfig))).toEqual([]);
  });
});

describe('runHarnessProbe', () => {
  it('returns null on exit 0', () => {
    expect(runHarnessProbe('true')).toBeNull();
  });

  it('returns the exit code on failure', () => {
    expect(runHarnessProbe('exit 3')).toBe('exit 3');
  });

  it('includes the first stderr line', () => {
    expect(runHarnessProbe('echo boom >&2; exit 2')).toContain('boom');
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

describe('isHarnessCliPresent', () => {
  it('is true for harnesses with no CLI probe even when no command is available', () => {
    expect(isHarnessCliPresent('ollama-http', () => false)).toBe(true);
    expect(isHarnessCliPresent('my-declared-harness', () => false)).toBe(true);
    expect(isHarnessCliPresent(undefined, () => false)).toBe(true);
  });

  it('follows the injected probe for CLI harnesses', () => {
    expect(isHarnessCliPresent('claude-cli', (cmd) => cmd !== 'claude')).toBe(false);
    expect(isHarnessCliPresent('claude-cli', (cmd) => cmd === 'claude')).toBe(true);
  });
});
