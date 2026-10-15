import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig } from './index.js';
import { applyRepoConfig, loadRepoConfig } from './repo.js';

type ModelDef = ModelsConfig['models'][string];

const baseModel = (over: Partial<ModelDef> = {}): ModelDef => ({
  provider: 'anthropic',
  tier: 'worker',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
  ...over,
});

const models: ModelsConfig = {
  version: 1,
  models: { 'claude-model': baseModel({ tier: 'boss' }) },
  tiers: { boss: ['claude-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRepoRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-endpoint-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeRepoConfig(repoRoot: string, content: unknown): Promise<void> {
  await mkdir(join(repoRoot, '.factory'), { recursive: true });
  await writeFile(join(repoRoot, '.factory', 'config.json'), JSON.stringify(content));
}

describe('applyRepoConfig registry endpoint (#2906)', () => {
  const endpointModel = (over: Partial<ModelDef> = {}) =>
    baseModel({
      provider: 'custom',
      harness: 'claude-cli',
      envKey: 'OPENROUTER_API_KEY',
      claudeFlag: 'deepseek/deepseek-v4-flash',
      endpoint: 'https://openrouter.ai/api',
      ...over,
    });
  const repoWith = (def: ModelDef) => ({ version: 2 as const, models: { registry: { 'ds-or': def } } });

  it('throws naming the allowed hosts and ADR-0163 for an unapproved endpoint host', () => {
    const repo = repoWith(endpointModel({ endpoint: 'https://api.deepseek.com/anthropic' }));
    expect(() => applyRepoConfig(models, repo)).toThrow(/openrouter\.ai/);
    expect(() => applyRepoConfig(models, repo)).toThrow(/ADR-0163/);
  });

  it('throws when an endpoint has a null envKey', () => {
    expect(() => applyRepoConfig(models, repoWith(endpointModel({ envKey: null })))).toThrow(/envKey is null/);
  });

  it('accepts an approved https OpenRouter endpoint', () => {
    const merged = applyRepoConfig(models, repoWith(endpointModel()));
    expect(merged.models['ds-or'].endpoint).toBe('https://openrouter.ai/api');
  });

  it('round-trips endpoint through loadRepoConfig', async () => {
    const repoRoot = await tempRepoRoot();
    await writeRepoConfig(repoRoot, { version: 2, models: { registry: { 'ds-or': endpointModel() } } });
    const loaded = loadRepoConfig(repoRoot);
    expect(loaded?.models?.registry?.['ds-or']?.endpoint).toBe('https://openrouter.ai/api');
  });
});
