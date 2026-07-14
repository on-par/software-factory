import { describe, expect, it } from 'vitest';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { OpenCodeHarness } from './opencode.js';
import { HarnessError } from './index.js';
import { ModelRegistry } from '../models/index.js';
import type { ModelsConfig } from '../config/index.js';

describe('CodingHarness contract: OpenCodeHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new OpenCodeHarness(async () => ({ stdout: 'opencode output', stderr: '' })) }),
    timeout: () => ({ harness: new OpenCodeHarness(async () => { throw Object.assign(new Error('killed'), { killed: true }); }) }),
    emptyOutput: () => ({ harness: new OpenCodeHarness(async () => ({ stdout: '   ', stderr: '' })) }),
    failure: () => ({ harness: new OpenCodeHarness(async () => { throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 }); }) }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
    'opencode-no-provider-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['opencode-model', 'opencode-no-provider-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string; opts: any }[] = [];
  const fn = async (cmd: string, opts: any) => {
    calls.push({ cmd, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('OpenCodeHarness command shape', () => {
  it('builds the expected invocation with a provider model', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    const result = await harness.run(makeContractRequest({
      model: 'opencode-model',
      registry,
      prompt: 'build it',
      worktree: '/tmp/factory worktree',
      timeoutSeconds: 7,
    }));

    expect(result.output).toBe('OPENCODE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    const { cmd, opts } = rec.calls[0];
    expect(cmd).toMatch(/^opencode run /);
    expect(cmd).toContain("--model 'anthropic/claude-sonnet-5'");
    expect(cmd).toContain("'build it'");
    expect(opts.cwd).toBe('/tmp/factory worktree');
    expect(opts.timeout).toBe(7 * 1000);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it('omits the model flag when no providerModel is configured', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'opencode-no-provider-model', registry, prompt: 'build it' }));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^opencode run /);
    expect(rec.calls[0].cmd).not.toContain('--model');
    expect(rec.calls[0].cmd).not.toContain('opencode-no-provider-model');
  });
});

describe('OpenCodeHarness failure classification', () => {
  it('classifies usage_cap from stderr', async () => {
    const harness = new OpenCodeHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'quota exceeded', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'opencode-model', registry })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.stderr).toBe('quota exceeded');
  });

  it('classifies killed exec as timeout', async () => {
    const harness = new OpenCodeHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'opencode-model', registry })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('timeout');
  });
});
