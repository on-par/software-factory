import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { loadModelsConfig, type ModelsConfig } from './index.js';
import {
  applyRepoConfig,
  loadRepoConfig,
  resolveEffectiveBuildRoute,
  resolveEffectiveModelPins,
  routeForBuildModel,
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
    'ollama-model': baseModel({ tier: 'worker', provider: 'ollama' }),
  },
  tiers: { boss: ['claude-model'], worker: ['ollama-model'], checker: [], triage: [] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

describe('resolveEffectiveModelPins agentic build pins', () => {
  const decl = {
    command: 'my-agent {model}',
    prompt: 'stdin',
    output: 'stdout',
    agentic: true,
    usage: 'none',
  } as const;
  const registry = new ModelRegistry({
    ...models,
    models: {
      ...models.models,
      'my-model': baseModel({ tier: 'worker', provider: 'anthropic', harness: 'my-agent' }),
      'good-model': baseModel({ tier: 'worker', provider: 'anthropic', harness: 'good-agent' }),
      'codex-chat': baseModel({ tier: 'worker', provider: 'openai', codex: true, harness: 'my-agent' }),
    },
    harnesses: { 'my-agent': { ...decl, agentic: false }, 'good-agent': decl },
  });
  const pins = (p: Record<string, string>) => ({ version: 2 as const, models: { pins: p } });

  it('refuses a repo build pin on a declared non-agentic harness', () => {
    const run = () => resolveEffectiveModelPins(registry, pins({ build: 'my-model' }), {});
    expect(run).toThrow(/BUILD needs an agentic harness/);
    expect(run).toThrow(/harnesses\.my-agent/);
    expect(run).toThrow(/my-model/);
  });

  it('refuses a repo build pin on the built-in ollama-http harness', () => {
    const run = () => resolveEffectiveModelPins(registry, pins({ build: 'ollama-model' }), {});
    expect(run).toThrow(/BUILD needs an agentic harness/);
    expect(run).toThrow(/ollama-http/);
    expect(run).not.toThrow(/harnesses\.ollama-http/);
  });

  it('refuses a FACTORY_BUILD_MODEL pin on a non-agentic harness', () => {
    expect(() => resolveEffectiveModelPins(registry, null, { FACTORY_BUILD_MODEL: 'my-model' })).toThrow(
      /FACTORY_BUILD_MODEL.*BUILD needs an agentic harness/s,
    );
  });

  it('accepts build pins on claude-cli and on a declared agentic harness', () => {
    expect(resolveEffectiveModelPins(registry, pins({ build: 'claude-model' }), {}).build).toBe('claude-model');
    expect(resolveEffectiveModelPins(registry, pins({ build: 'good-model' }), {}).build).toBe('good-model');
  });

  it('lets an agentic repo build pin override a non-agentic env pin', () => {
    const result = resolveEffectiveModelPins(registry, pins({ build: 'claude-model' }), {
      FACTORY_BUILD_MODEL: 'my-model',
    });
    expect(result.build).toBe('claude-model');
  });

  it('refuses a non-agentic buildFallback', () => {
    expect(() => resolveEffectiveModelPins(registry, pins({ buildFallback: 'codex-chat' }), {})).toThrow(
      /models\.pins\.buildFallback.*BUILD needs an agentic harness/s,
    );
  });

  it('does not check plan pins for agentic harnesses', () => {
    expect(resolveEffectiveModelPins(registry, pins({ plan: 'ollama-model' }), {}).plan).toBe('ollama-model');
  });
});

describe('routeForBuildModel / resolveEffectiveBuildRoute command route', () => {
  const decl = {
    command: 'my-agent {model}',
    prompt: 'stdin',
    output: 'stdout',
    agentic: true,
    usage: 'none',
  } as const;
  const registry = new ModelRegistry({
    ...models,
    models: {
      ...models.models,
      'my-model': baseModel({ tier: 'worker', provider: 'anthropic', harness: 'my-agent' }),
      'plain-model': baseModel({ tier: 'worker', provider: 'anthropic', harness: 'lazy-agent' }),
      'codex-model': baseModel({ tier: 'worker', provider: 'openai', codex: true }),
      'codex-chat': baseModel({ tier: 'worker', provider: 'openai', codex: true, harness: 'my-agent' }),
      'oc-model': baseModel({ tier: 'worker', provider: 'deepseek', harness: 'opencode' }),
    },
    harnesses: { 'my-agent': decl, 'lazy-agent': { ...decl, agentic: false } },
  });

  it('derives the command route from a build pin on a declared agentic harness', () => {
    expect(resolveEffectiveBuildRoute(registry, null, { build: 'my-model', sources: {} })).toEqual({
      route: 'command',
      source: 'build-pin',
    });
    const repo = { version: 2 as const, route: 'claude' as const };
    expect(resolveEffectiveBuildRoute(registry, repo, { build: 'my-model', sources: {} })).toEqual({
      route: 'claude',
      source: 'repo',
    });
  });

  it('routeForBuildModel keeps built-in harness routes and ignores declared non-agentic harnesses', () => {
    expect(routeForBuildModel(registry, 'claude-model')).toBe('claude');
    expect(routeForBuildModel(registry, 'codex-model')).toBe('codex');
    expect(routeForBuildModel(registry, 'oc-model')).toBe('opencode');
    expect(routeForBuildModel(registry, 'plain-model')).toBeUndefined();
    expect(routeForBuildModel(registry, 'ollama-model')).toBeUndefined();
    expect(routeForBuildModel(registry, 'nope')).toBeUndefined();
    expect(routeForBuildModel(registry, undefined)).toBeUndefined();
    expect(routeForBuildModel(registry, 'codex-chat')).toBe('command');
    expect(routeForBuildModel(registry, 'my-model')).toBe('command');
  });
});

const tempDirs = new Set<string>();
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function loadPins(yaml: string) {
  vi.stubEnv('FACTORY_RUN_CONFIG_JSON', undefined);
  const root = await mkdtemp(join(tmpdir(), 'repo-build-pin-test-'));
  tempDirs.add(root);
  await mkdir(join(root, '.factory'), { recursive: true });
  await writeFile(join(root, '.factory', 'config.yaml'), yaml);
  const repo = loadRepoConfig(root);
  const applied = applyRepoConfig(loadModelsConfig(), repo);
  const registry = new ModelRegistry(applied);
  return { applied, run: () => resolveEffectiveModelPins(registry, repo, {}) };
}

function configYaml(agentic: boolean, pins: string[]): string {
  return `version: 2
harnesses:
  chat-agent:
    command: chat-agent {model}
    prompt: stdin
    output: stdout
    agentic: ${agentic}
    usage: none
models:
  registry:
    chat-model:
      provider: anthropic
      tier: worker
      costPerMtokInput: 0
      costPerMtokOutput: 0
      contextWindow: 1000
      capabilities: []
      envKey: null
      harness: chat-agent
  pins:
${pins.map((line) => `    ${line}`).join('\n')}
`;
}

describe('agentic BUILD pin through config load (#3062)', () => {
  it('refuses a build pin on a declared non-agentic harness loaded from config', async () => {
    const { run } = await loadPins(configYaml(false, ['build: chat-model']));
    expect(run).toThrow(/BUILD needs an agentic harness/);
    expect(run).toThrow(/chat-agent/);
    expect(run).toThrow(/chat-model/);
    expect(run).toThrow(/models\.pins\.build/);
  });

  it('loads a build pin on a declared agentic harness from config', async () => {
    const { run } = await loadPins(configYaml(true, ['build: chat-model']));
    expect(run().build).toBe('chat-model');
  });

  it('loads a non-agentic declared harness pinned only for plan and checker', async () => {
    const { applied, run } = await loadPins(configYaml(false, ['plan: chat-model', 'checker: chat-model']));
    expect(run).not.toThrow();
    expect(run().plan).toBe('chat-model');
    expect(applied.tiers.checker).toEqual(['chat-model']);
  });
});
