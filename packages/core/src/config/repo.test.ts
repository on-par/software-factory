import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { ModelsConfig, RoutesConfig } from './index.js';
import {
  applyRepoConfig,
  describeEffectiveConfig,
  loadRepoConfig,
  resolveCodexDisabled,
  resolveEffectiveModelPins,
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

  it('parses a valid file', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { version: 1, models: { plan: 'claude-model' } });
    expect(loadRepoConfig(repoRoot)).toEqual({ version: 1, models: { plan: 'claude-model' } });
  });

  it('parses a valid empty object as a no-op', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, {});
    expect(loadRepoConfig(repoRoot)).toEqual({ version: 1 });
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

  it('rejects a non-positive usage.capUsd', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { usage: { capUsd: -5 } });
    expect(() => loadRepoConfig(repoRoot)).toThrow();
  });
});

describe('applyRepoConfig', () => {
  it('is the identity transform for a null repo config', () => {
    expect(applyRepoConfig(models, null)).toEqual(models);
    expect(applyRepoConfig(models, null)).toBe(models);
  });

  it('is a no-op for an empty repo config object', () => {
    expect(applyRepoConfig(models, { version: 1 })).toEqual(models);
  });

  it('replaces a tier order wholesale', () => {
    const result = applyRepoConfig(models, { version: 1, tiers: { worker: ['ollama-model', 'gpt-model-a'] } });
    expect(result.tiers.worker).toEqual(['ollama-model', 'gpt-model-a']);
    expect(result.tiers.boss).toEqual(models.tiers.boss);
  });

  it('throws naming the tier and the unknown model id in a tier override', () => {
    expect(() => applyRepoConfig(models, { version: 1, tiers: { worker: ['no-such-model'] } })).toThrow(
      /worker.*no-such-model/s,
    );
  });

  it('strips both openai models from all tiers when providers.openai is false', () => {
    const result = applyRepoConfig(models, { version: 1, providers: { openai: false } });
    expect(result.tiers.worker).toEqual(['ollama-model']);
    expect(result.tiers.checker).toEqual(['checker-model']);
  });

  it('strips ollama models from all tiers when providers.ollama is false', () => {
    const result = applyRepoConfig(models, { version: 1, providers: { ollama: false } });
    expect(result.tiers.worker).toEqual(['gpt-model-a']);
  });

  it('rewrites the checker tier to a single pinned model', () => {
    const result = applyRepoConfig(models, { version: 1, models: { checker: 'checker-model' } });
    expect(result.tiers.checker).toEqual(['checker-model']);
  });

  it('rewrites the triage tier to a single pinned model', () => {
    const result = applyRepoConfig(models, { version: 1, models: { triage: 'triage-model' } });
    expect(result.tiers.triage).toEqual(['triage-model']);
  });

  it('throws naming the unknown checker pin', () => {
    expect(() => applyRepoConfig(models, { version: 1, models: { checker: 'no-such-model' } })).toThrow(
      /checker.*no-such-model/s,
    );
  });

  it('throws naming the unknown triage pin', () => {
    expect(() => applyRepoConfig(models, { version: 1, models: { triage: 'no-such-model' } })).toThrow(
      /triage.*no-such-model/s,
    );
  });

  it('throws naming the tier emptied by a provider disable', () => {
    const onlyOpenai: ModelsConfig = {
      ...models,
      tiers: { ...models.tiers, worker: ['gpt-model-a'] },
    };
    expect(() => applyRepoConfig(onlyOpenai, { version: 1, providers: { openai: false } })).toThrow(/worker/);
  });

  it('does not mutate the input ModelsConfig', () => {
    const snapshot = JSON.parse(JSON.stringify(models));
    applyRepoConfig(models, { version: 1, tiers: { worker: ['ollama-model'] }, providers: { openai: false } });
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
    const result = resolveEffectiveModelPins(registry, { version: 1, models: { plan: 'claude-model' } }, {});
    expect(result).toEqual({ plan: 'claude-model', build: undefined, sources: { plan: 'repo' } });
  });

  it('repo pins win over env pins', () => {
    const result = resolveEffectiveModelPins(
      registry,
      { version: 1, models: { plan: 'claude-model' } },
      { FACTORY_PLAN_MODEL: 'gpt-model-a' },
    );
    expect(result.plan).toBe('claude-model');
    expect(result.sources.plan).toBe('repo');
  });

  it('reports sources correctly for a mixed plan/build scenario', () => {
    const result = resolveEffectiveModelPins(
      registry,
      { version: 1, models: { build: 'ollama-model' } },
      { FACTORY_PLAN_MODEL: 'claude-model' },
    );
    expect(result).toEqual({
      plan: 'claude-model',
      build: 'ollama-model',
      sources: { plan: 'env', build: 'repo' },
    });
  });

  it('throws naming an unknown repo plan pin', () => {
    expect(() => resolveEffectiveModelPins(registry, { version: 1, models: { plan: 'no-such-model' } }, {})).toThrow(
      /no-such-model/,
    );
  });

  it('throws naming an unknown repo build pin', () => {
    expect(() => resolveEffectiveModelPins(registry, { version: 1, models: { build: 'no-such-model' } }, {})).toThrow(
      /no-such-model/,
    );
  });
});

describe('resolveCodexDisabled', () => {
  function check(openai: boolean | undefined, factoryCodex: string | undefined, expected: boolean) {
    const repo = openai === undefined ? null : { version: 1 as const, providers: { openai } };
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

describe('resolveUsageCap', () => {
  it('uses the repo cap over the env cap', () => {
    expect(resolveUsageCap({ version: 1, usage: { capUsd: 50 } }, { FACTORY_USAGE_CAP: '100' })).toEqual({
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
      version: 1 as const,
      models: { checker: 'checker-model' },
      providers: { ollama: false },
      usage: { capUsd: 42 },
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
      repo: { version: 1, tiers: { worker: ['ollama-model', 'gpt-model-a'] } },
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
});
