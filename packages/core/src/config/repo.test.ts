import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { loadModelsConfig, type ModelsConfig, type RoutesConfig } from './index.js';
import {
  applyRepoConfig,
  adaptV1ToV2,
  describeEffectiveConfig,
  loadRepoConfig,
  resolveCodexDisabled,
  resolveEffectiveConfig,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveUsageCap,
} from './repo.js';

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
  models: {
    'claude-model': baseModel({ tier: 'boss', provider: 'anthropic' }),
    'gpt-model-a': baseModel({ tier: 'worker', provider: 'openai', codex: true }),
    'gpt-model-b': baseModel({ tier: 'checker', provider: 'openai' }),
    'ollama-model': baseModel({ tier: 'worker', provider: 'ollama' }),
    'checker-model': baseModel({ tier: 'checker', provider: 'anthropic' }),
    'triage-model': baseModel({ tier: 'triage', provider: 'anthropic' }),
  },
  tiers: {
    boss: ['claude-model'],
    worker: ['gpt-model-a', 'ollama-model'],
    checker: ['gpt-model-b', 'checker-model'],
    triage: ['triage-model'],
  },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    check_tests: { tier: 'checker', description: 'stub' },
    triage: { tier: 'triage', description: 'stub' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function tempRepoRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-config-test-'));
  tempDirs.add(dir);
  return dir;
}

async function writeRepoConfig(repoRoot: string, content: unknown): Promise<void> {
  await mkdir(join(repoRoot, '.factory'), { recursive: true });
  await writeFile(join(repoRoot, '.factory', 'config.json'), JSON.stringify(content));
}

describe('loadRepoConfig', () => {
  it('returns null when the file does not exist', async () => {
    const repoRoot = await tempRepoRoot();
    expect(loadRepoConfig(repoRoot)).toBeNull();
  });

  it('adapts a complete v1 file to the canonical v2 shape and warns once per path', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {
      version: 1,
      models: {
        plan: 'claude-model',
        planFallback: 'gpt-model-a',
        build: 'gpt-model-a',
        buildFallback: 'gpt-model-a',
        checker: 'checker-model',
        triage: 'triage-model',
      },
      usage: { capUsd: 50 },
      efficiency: { fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
      providers: { anthropic: false, openai: true, ollama: false },
      tiers: { worker: ['gpt-model-a'] },
      route: 'opencode',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(loadRepoConfig(repoRoot)).toEqual({
      version: 2,
      models: {
        pins: {
          plan: 'claude-model',
          planFallback: 'gpt-model-a',
          build: 'gpt-model-a',
          buildFallback: 'gpt-model-a',
          checker: 'checker-model',
          triage: 'triage-model',
        },
      },
      policy: { mode: 'pinned' },
      budget: { capUsd: 50, fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
      providers: { anthropic: false, openai: true, ollama: false },
      tiers: { worker: ['gpt-model-a'] },
      route: 'opencode',
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('factory migrate'));
    loadRepoConfig(repoRoot);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('loads configuration from an external state root without creating checkout-local state', async () => {
    const repoRoot = await tempRepoRoot();
    const stateRoot = await tempRepoRoot();
    await writeFile(join(stateRoot, 'config.json'), JSON.stringify({ version: 1, models: { plan: 'claude-model' } }));

    expect(loadRepoConfig(repoRoot, stateRoot)).toEqual({
      version: 2,
      models: { pins: { plan: 'claude-model' } },
      policy: { mode: 'pinned' },
    });
    expect(existsSync(join(repoRoot, '.factory'))).toBe(false);
  });

  it('parses explicit provider fallback preferences for PLAN and BUILD', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {
      models: {
        plan: 'claude-model',
        planFallback: 'gpt-model-a',
        build: 'gpt-model-a',
        buildFallback: 'claude-model',
      },
    });
    expect(loadRepoConfig(repoRoot)?.models?.pins).toMatchObject({
      plan: 'claude-model',
      planFallback: 'gpt-model-a',
      build: 'gpt-model-a',
      buildFallback: 'claude-model',
    });
  });

  it('parses a valid empty object as a no-op', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {});
    expect(loadRepoConfig(repoRoot)).toEqual({ version: 2 });
  });

  it('throws naming the file path on malformed JSON', async () => {
    const repoRoot = await tempRepoRoot();
    await mkdir(join(repoRoot, '.factory'), { recursive: true });
    await writeFile(join(repoRoot, '.factory', 'config.json'), '{ not json');
    expect(() => loadRepoConfig(repoRoot)).toThrow(/\.factory[/\\]config\.json/);
  });

  it('rejects an unknown top-level key', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { bogus: true });
    expect(() => loadRepoConfig(repoRoot)).toThrow(/\.factory[/\\]config\.json/);
  });

  it('rejects an unknown key nested under models', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { models: { bogus: 'x' } });
    expect(() => loadRepoConfig(repoRoot)).toThrow();
  });

  it('parses a file carrying both namespaces — model pins intact, runtime keys ignored, no throw', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {
      models: { plan: 'claude-model' },
      merge: { auto: true },
      worktree: { gcTtlDays: 30 },
    });
    expect(loadRepoConfig(repoRoot)).toEqual({
      version: 2,
      models: { pins: { plan: 'claude-model' } },
      policy: { mode: 'pinned' },
    });
  });

  it('still rejects a genuine root-level typo with the file path in the message', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { modles: {} });
    expect(() => loadRepoConfig(repoRoot)).toThrow(/\.factory[/\\]config\.json/);
  });

  it('rejects a non-positive usage.capUsd in a v1 file', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { usage: { capUsd: -5 } });
    expect(() => loadRepoConfig(repoRoot)).toThrow();
  });

  it('parses bounded fast-path and per-issue budget controls', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {
      efficiency: { fastPath: true, maxReworkRounds: 1, perIssueCapUsd: 8 },
    });

    expect(loadRepoConfig(repoRoot)).toEqual({
      version: 2,
      budget: { fastPath: true, maxReworkRounds: 1, perIssueCapUsd: 8 },
    });
  });

  it('accepts a version-2 file with $schema — the shape `factory init` writes — with no pins', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { $schema: 'http://x', version: 2 });
    expect(loadRepoConfig(repoRoot)).toEqual({ $schema: 'http://x', version: 2 });
  });

  it('loads a minimal version-2 file without warning', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { version: 2 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(loadRepoConfig(repoRoot)).toEqual({ version: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a v2 file containing a v1 key with the path and key in the error', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { version: 2, usage: { capUsd: 50 } });
    expect(() => loadRepoConfig(repoRoot)).toThrow(/config\.json.*usage/s);
  });

  it('rejects an unsupported version number', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { version: 3 });
    expect(() => loadRepoConfig(repoRoot)).toThrow(/\.factory[/\\]config\.json/);
  });

  it('a zero-file repo (no .factory/config.json) returns null — the factory run zero-file regression guard', async () => {
    const repoRoot = await tempRepoRoot();
    expect(existsSync(join(repoRoot, '.factory', 'config.json'))).toBe(false);
    expect(loadRepoConfig(repoRoot)).toBeNull();
  });
});

describe('adaptV1ToV2', () => {
  it('omits empty optional sections', () => {
    expect(adaptV1ToV2({})).toEqual({ version: 2 });
    expect(adaptV1ToV2({ models: {} })).toEqual({ version: 2 });
  });

  it('preserves effective behavior against a handwritten v2 twin', () => {
    const v1 = {
      models: {
        plan: 'claude-model',
        planFallback: 'gpt-model-a',
        build: 'gpt-model-a',
        buildFallback: 'gpt-model-a',
        checker: 'checker-model',
        triage: 'triage-model',
      },
      usage: { capUsd: 50 },
      efficiency: { fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
      providers: { openai: false },
      tiers: { worker: ['ollama-model'] },
      route: 'opencode' as const,
    };
    const v2 = {
      version: 2 as const,
      models: {
        pins: {
          plan: 'claude-model',
          planFallback: 'gpt-model-a',
          build: 'gpt-model-a',
          buildFallback: 'gpt-model-a',
          checker: 'checker-model',
          triage: 'triage-model',
        },
      },
      policy: { mode: 'pinned' as const },
      budget: { capUsd: 50, fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
      providers: { openai: false },
      tiers: { worker: ['ollama-model'] },
      route: 'opencode' as const,
    };
    const adapted = adaptV1ToV2(v1);
    const registry = new ModelRegistry(models);

    expect(resolveEffectiveModelPins(registry, adapted, {})).toEqual(resolveEffectiveModelPins(registry, v2, {}));
    expect(resolveUsageCap(adapted, {})).toEqual(resolveUsageCap(v2, {}));
    expect(resolveEfficiencyPolicy(adapted)).toEqual(resolveEfficiencyPolicy(v2));
    expect(resolveCodexDisabled(adapted, {})).toEqual(resolveCodexDisabled(v2, {}));
    expect(applyRepoConfig(models, adapted)).toEqual(applyRepoConfig(models, v2));
  });
});

describe('resolveEfficiencyPolicy', () => {
  it('uses conservative defaults when a repo has no efficiency policy', () => {
    expect(resolveEfficiencyPolicy(null)).toEqual({ fastPath: false, maxReworkRounds: 1, perIssueCapUsd: undefined });
  });

  it('exposes the repo efficiency policy to the pipeline', () => {
    expect(
      resolveEfficiencyPolicy({ version: 2, budget: { fastPath: true, maxReworkRounds: 1, perIssueCapUsd: 8 } }),
    ).toEqual({ fastPath: true, maxReworkRounds: 1, perIssueCapUsd: 8 });
  });
});

describe('applyRepoConfig', () => {
  it('is the identity transform for a null repo config', () => {
    expect(applyRepoConfig(models, null)).toEqual(models);
    expect(applyRepoConfig(models, null)).toBe(models);
  });

  it('is a no-op for an empty repo config object', () => {
    expect(applyRepoConfig(models, { version: 2 })).toEqual(models);
  });

  it('replaces a tier order wholesale', () => {
    const result = applyRepoConfig(models, { version: 2, tiers: { worker: ['ollama-model', 'gpt-model-a'] } });
    expect(result.tiers.worker).toEqual(['ollama-model', 'gpt-model-a']);
    expect(result.tiers.boss).toEqual(models.tiers.boss);
  });

  it('throws naming the tier and the unknown model id in a tier override', () => {
    expect(() => applyRepoConfig(models, { version: 2, tiers: { worker: ['no-such-model'] } })).toThrow(
      /worker.*no-such-model/s,
    );
  });

  it('strips both openai models from all tiers when providers.openai is false', () => {
    const result = applyRepoConfig(models, { version: 2, providers: { openai: false } });
    expect(result.tiers.worker).toEqual(['ollama-model']);
    expect(result.tiers.checker).toEqual(['checker-model']);
  });

  it('strips ollama models from all tiers when providers.ollama is false', () => {
    const result = applyRepoConfig(models, { version: 2, providers: { ollama: false } });
    expect(result.tiers.worker).toEqual(['gpt-model-a']);
  });

  it('rewrites the checker tier to a single pinned model', () => {
    const result = applyRepoConfig(models, { version: 2, models: { pins: { checker: 'checker-model' } } });
    expect(result.tiers.checker).toEqual(['checker-model']);
  });

  it('rewrites the triage tier to a single pinned model', () => {
    const result = applyRepoConfig(models, { version: 2, models: { pins: { triage: 'triage-model' } } });
    expect(result.tiers.triage).toEqual(['triage-model']);
  });

  it('throws naming the unknown checker pin', () => {
    expect(() => applyRepoConfig(models, { version: 2, models: { pins: { checker: 'no-such-model' } } })).toThrow(
      /checker.*no-such-model/s,
    );
  });

  it('throws naming the unknown triage pin', () => {
    expect(() => applyRepoConfig(models, { version: 2, models: { pins: { triage: 'no-such-model' } } })).toThrow(
      /triage.*no-such-model/s,
    );
  });

  it('throws naming the tier emptied by a provider disable', () => {
    const onlyOpenai: ModelsConfig = {
      ...models,
      tiers: { ...models.tiers, worker: ['gpt-model-a'] },
    };
    expect(() => applyRepoConfig(onlyOpenai, { version: 2, providers: { openai: false } })).toThrow(/worker/);
  });

  it('does not mutate the input ModelsConfig', () => {
    const snapshot = JSON.parse(JSON.stringify(models));
    applyRepoConfig(models, { version: 2, tiers: { worker: ['ollama-model'] }, providers: { openai: false } });
    expect(models).toEqual(snapshot);
  });
});

describe('resolveEffectiveModelPins', () => {
  const registry = new ModelRegistry(models);

  it('resolves env-only pins with parity to resolveModelOverrides', () => {
    const result = resolveEffectiveModelPins(registry, null, { FACTORY_PLAN_MODEL: 'claude-model' });
    expect(result).toEqual({ plan: 'claude-model', build: undefined, sources: { plan: 'env' } });
  });

  it('resolves repo-only pins', () => {
    const result = resolveEffectiveModelPins(registry, { version: 2, models: { pins: { plan: 'claude-model' } } }, {});
    expect(result).toEqual({ plan: 'claude-model', build: undefined, sources: { plan: 'repo' } });
  });

  it('resolves the configured fallback alongside a preferred pin', () => {
    const result = resolveEffectiveModelPins(
      registry,
      { version: 2, models: { pins: { plan: 'claude-model', planFallback: 'gpt-model-a' } } },
      {},
    );
    expect(result).toMatchObject({ plan: 'claude-model', planFallback: 'gpt-model-a' });
  });

  it('rejects a non-Codex build fallback', () => {
    expect(() =>
      resolveEffectiveModelPins(registry, { version: 2, models: { pins: { buildFallback: 'claude-model' } } }, {}),
    ).toThrow(/buildFallback must be a Codex-capable model/);
  });

  it('repo pins win over env pins', () => {
    const result = resolveEffectiveModelPins(
      registry,
      { version: 2, models: { pins: { plan: 'claude-model' } } },
      { FACTORY_PLAN_MODEL: 'gpt-model-a' },
    );
    expect(result.plan).toBe('claude-model');
    expect(result.sources.plan).toBe('repo');
  });

  it('reports sources correctly for a mixed plan/build scenario', () => {
    const result = resolveEffectiveModelPins(
      registry,
      { version: 2, models: { pins: { build: 'ollama-model' } } },
      { FACTORY_PLAN_MODEL: 'claude-model' },
    );
    expect(result).toEqual({
      plan: 'claude-model',
      build: 'ollama-model',
      sources: { plan: 'env', build: 'repo' },
    });
  });

  it('throws naming an unknown repo plan pin', () => {
    expect(() =>
      resolveEffectiveModelPins(registry, { version: 2, models: { pins: { plan: 'no-such-model' } } }, {}),
    ).toThrow(/no-such-model/);
  });

  it('throws naming an unknown repo build pin', () => {
    expect(() =>
      resolveEffectiveModelPins(registry, { version: 2, models: { pins: { build: 'no-such-model' } } }, {}),
    ).toThrow(/no-such-model/);
  });
});

describe('terra default overrides (#529)', () => {
  const shippedRegistry = new ModelRegistry(loadModelsConfig());

  it('accepts the new terra ids as env pin targets', () => {
    const result = resolveEffectiveModelPins(shippedRegistry, null, {
      FACTORY_PLAN_MODEL: 'gpt-5.6-terra-high',
      FACTORY_BUILD_MODEL: 'gpt-5.6-terra-medium',
    });
    expect(result).toEqual({
      plan: 'gpt-5.6-terra-high',
      build: 'gpt-5.6-terra-medium',
      sources: { plan: 'env', build: 'env' },
    });
  });

  it('lets a repo pin beat both an env pin and the terra defaults', () => {
    const result = resolveEffectiveModelPins(
      shippedRegistry,
      { version: 2, models: { pins: { plan: 'claude-opus-5', build: 'gpt-5.6-sol' } } },
      { FACTORY_PLAN_MODEL: 'gpt-5.6-terra-high' },
    );
    expect(result).toEqual({
      plan: 'claude-opus-5',
      build: 'gpt-5.6-sol',
      sources: { plan: 'repo', build: 'repo' },
    });
  });
});

describe('resolveCodexDisabled', () => {
  function check(openai: boolean | undefined, factoryCodex: string | undefined, expected: boolean) {
    const repo = openai === undefined ? null : { version: 2 as const, providers: { openai } };
    const env = factoryCodex === undefined ? {} : { FACTORY_CODEX: factoryCodex };
    expect(resolveCodexDisabled(repo, env)).toBe(expected);
  }

  it('providers.openai=true wins over FACTORY_CODEX in every state', () => {
    check(true, undefined, false);
    check(true, '0', false);
    check(true, '1', false);
  });

  it('providers.openai=false wins over FACTORY_CODEX in every state', () => {
    check(false, undefined, true);
    check(false, '0', true);
    check(false, '1', true);
  });

  it('falls back to the FACTORY_CODEX kill-switch when providers.openai is absent', () => {
    check(undefined, undefined, false);
    check(undefined, '0', true);
    check(undefined, '1', false);
  });
});

describe('resolveEffectiveConfig', () => {
  it('repo providers.openai=false beats FACTORY_CODEX=1 and keeps the env toggles', () => {
    const repo = { version: 2 as const, providers: { openai: false } };
    const effective = resolveEffectiveConfig(repo, {
      FACTORY_CODEX: '1',
      FACTORY_LOCAL_ONLY: '1',
      FACTORY_EXPERIMENTAL: '1',
      FACTORY_BRANCH_PREFIX: 'compare-local',
    });
    expect(effective).toEqual({
      localOnly: true,
      allowExperimental: true,
      codexDisabled: true,
      branchPrefix: 'compare-local',
    });
  });

  it('absent repo falls back to env for all four values', () => {
    const effective = resolveEffectiveConfig(null, {
      FACTORY_CODEX: '0',
      FACTORY_BRANCH_PREFIX: 'compare-local',
    });
    expect(effective).toEqual({
      localOnly: false,
      allowExperimental: false,
      codexDisabled: true,
      branchPrefix: 'compare-local',
    });
  });

  it('uses conservative defaults when nothing is set', () => {
    expect(resolveEffectiveConfig(null, {})).toEqual({
      localOnly: false,
      allowExperimental: false,
      codexDisabled: false,
      branchPrefix: 'ship-it',
    });
  });
});

describe('resolveUsageCap', () => {
  it('uses the repo cap over the env cap', () => {
    expect(resolveUsageCap({ version: 2, budget: { capUsd: 50 } }, { FACTORY_USAGE_CAP: '100' })).toEqual({
      cap: 50,
      source: 'repo',
    });
  });

  it('uses the env cap when no repo cap is set', () => {
    expect(resolveUsageCap(null, { FACTORY_USAGE_CAP: '100' })).toEqual({ cap: 100, source: 'env' });
  });

  it('uses the packaged default of 227 when neither is set', () => {
    expect(resolveUsageCap(null, {})).toEqual({ cap: 227, source: 'default' });
  });

  it('rejects a non-positive env cap', () => {
    expect(() => resolveUsageCap(null, { FACTORY_USAGE_CAP: '-1' })).toThrow(/FACTORY_USAGE_CAP/);
  });
});

describe('describeEffectiveConfig', () => {
  it('reports repo, env, and default sources for a mixed scenario', () => {
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);
    const repo = {
      version: 2 as const,
      models: { pins: { checker: 'checker-model' } },
      providers: { ollama: false },
      budget: { capUsd: 42 },
    };
    const lines = describeEffectiveConfig({
      router,
      repo,
      env: { FACTORY_PLAN_MODEL: 'claude-model' },
      repoConfigPath: '.factory/config.json',
    });

    expect(lines).toContainEqual(expect.stringContaining('Plan model: claude-model (env: FACTORY_PLAN_MODEL)'));
    expect(lines).toContainEqual(expect.stringContaining('Checker model: checker-model (.factory/config.json)'));
    expect(lines).toContainEqual(expect.stringContaining('Provider ollama: off (.factory/config.json)'));
    expect(lines).toContainEqual(expect.stringContaining('Provider anthropic: on (default)'));
    expect(lines).toContainEqual(expect.stringContaining('Usage cap: $42 (.factory/config.json)'));
  });

  it('lists tier-order overrides from the repo file', () => {
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);
    const lines = describeEffectiveConfig({
      router,
      repo: { version: 2, tiers: { worker: ['ollama-model', 'gpt-model-a'] } },
      env: {},
      repoConfigPath: '.factory/config.json',
    });

    expect(lines).toContainEqual('Tier override worker: ollama-model gpt-model-a (.factory/config.json)');
  });

  it('reports defaults when no repo config or env overrides are present', () => {
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);
    const lines = describeEffectiveConfig({ router, repo: null, env: {}, repoConfigPath: '.factory/config.json' });

    expect(lines).toContainEqual(expect.stringContaining('Plan model: claude-model (default)'));
    expect(lines).toContainEqual(expect.stringContaining('Usage cap: $227 (default)'));
    expect(lines).toContainEqual(expect.stringContaining('Provider openai: on (default)'));
  });

  it('reports local-only, experimental, and branch prefix from env with source labels', () => {
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);
    const lines = describeEffectiveConfig({
      router,
      repo: null,
      env: { FACTORY_LOCAL_ONLY: '1', FACTORY_EXPERIMENTAL: '1', FACTORY_BRANCH_PREFIX: 'compare-local' },
      repoConfigPath: '.factory/config.json',
    });

    expect(lines).toContainEqual(expect.stringContaining('Local only: on (env: FACTORY_LOCAL_ONLY)'));
    expect(lines).toContainEqual(expect.stringContaining('Experimental models: on (env: FACTORY_EXPERIMENTAL)'));
    expect(lines).toContainEqual(expect.stringContaining('Branch prefix: compare-local (env: FACTORY_BRANCH_PREFIX)'));
  });

  it('reports local-only/experimental off and the default branch prefix when unset', () => {
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);
    const lines = describeEffectiveConfig({ router, repo: null, env: {}, repoConfigPath: '.factory/config.json' });

    expect(lines).toContainEqual(expect.stringContaining('Local only: off (default)'));
    expect(lines).toContainEqual(expect.stringContaining('Experimental models: off (default)'));
    expect(lines).toContainEqual(expect.stringContaining('Branch prefix: ship-it (default)'));
  });
});
