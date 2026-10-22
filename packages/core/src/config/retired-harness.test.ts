import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadModelsConfig } from './index.js';

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function writeConfig(harness?: string, harnesses?: Record<string, unknown>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'factory-retired-harness-'));
  const config = {
    version: 1,
    models: {
      'some-model': {
        provider: 'ollama',
        tier: 'boss',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
        ...(harness ? { harness } : {}),
      },
    },
    tiers: { boss: ['some-model'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
    ...(harnesses ? { harnesses } : {}),
  };
  const path = join(tmpDir, 'models.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe('retired ollama-command-agent in models config', () => {
  it('accepts a model whose harness is the retired alias', async () => {
    const path = await writeConfig('ollama-command-agent');
    expect(() => loadModelsConfig(path)).not.toThrow();
  });

  it('refuses to redeclare the retired alias under harnesses', async () => {
    const decl = { command: 'my-agent', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' };
    const path = await writeConfig(undefined, { 'ollama-command-agent': decl });
    expect(() => loadModelsConfig(path)).toThrow(/ollama-command-agent.*built in/s);
  });

  it('still rejects a typo and does not list the alias among valid harnesses', async () => {
    const path = await writeConfig('ollama-commandagent');
    expect(() => loadModelsConfig(path)).toThrow(/ollama-commandagent/);
    expect(() => loadModelsConfig(path)).toThrow(/valid harnesses: (?!.*ollama-command-agent[,;)])/s);
  });
});
