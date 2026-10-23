import { readdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { createTempDirs } from './temp-dir.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'claude-model': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      claudeFlag: 'claude-sonnet-5',
    },
  },
  tiers: { boss: ['claude-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);
const envelope = () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CLAUDE OUTPUT' });

describe('ClaudeCliHarness prompt dir cleanup', () => {
  const tmp = createTempDirs();
  let scratch: string;
  let savedTmpdir: string | undefined;

  beforeEach(() => {
    savedTmpdir = process.env.TMPDIR;
    scratch = tmp.makeSync('prompt-cleanup-test-');
    process.env.TMPDIR = scratch;
  });

  afterEach(async () => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    await tmp.cleanup();
  });

  const promptDirs = () => readdirSync(scratch).filter((n) => n.startsWith('factory-claude-prompt-'));

  it('removes the prompt dir after a successful run', async () => {
    await new ClaudeCliHarness(async () => ({ stdout: envelope(), stderr: '' })).run(
      makeContractRequest({ model: 'claude-model', registry }),
    );
    expect(promptDirs()).toEqual([]);
  });

  it('removes the prompt dir when the exec fails', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: 'x' });
    });
    await expect(harness.run(makeContractRequest({ model: 'claude-model', registry }))).rejects.toBeInstanceOf(
      HarnessError,
    );
    expect(promptDirs()).toEqual([]);
  });

  it('removes the prompt dir when writing the prompt fails', async () => {
    // A non-string prompt makes the real writeFile reject after the dir exists, without module mocking.
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(
      new ClaudeCliHarness(exec).run(makeContractRequest({ model: 'claude-model', registry, prompt: 42 as never })),
    ).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
    expect(promptDirs()).toEqual([]);
  });
});
