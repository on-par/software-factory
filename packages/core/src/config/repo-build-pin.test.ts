import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { ModelsConfig } from './index.js';
import { resolveEffectiveModelPins } from './repo.js';

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
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
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
