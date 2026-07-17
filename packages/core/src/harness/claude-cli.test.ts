import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

describe('CodingHarness contract: ClaudeCliHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new ClaudeCliHarness(async () => ({ stdout: 'claude output', stderr: '' })) }),
    timeout: () => ({
      harness: new ClaudeCliHarness(async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      }),
    }),
    emptyOutput: () => ({ harness: new ClaudeCliHarness(async () => ({ stdout: '   ', stderr: '' })) }),
    failure: () => ({
      harness: new ClaudeCliHarness(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
      }),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

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
    'claude-no-flag': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['claude-model', 'claude-no-flag'] },
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

describe('ClaudeCliHarness command shape', () => {
  it('builds the expected invocation with a model flag', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(
      makeContractRequest({
        model: 'claude-model',
        registry,
        prompt: 'draft plan',
        worktree: '/tmp/factory worktree',
        timeoutSeconds: 7,
      }),
    );

    expect(result.output).toBe('CLAUDE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).toContain("'draft plan'");
    expect(rec.calls[0].cmd).toContain('--model claude-sonnet-5');
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
    expect(rec.calls[0].opts.cwd).toBe('/tmp/factory worktree');
    expect(rec.calls[0].opts.timeoutMs).toBe(7 * 1000);
    expect(rec.calls[0].opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it('omits the model flag when none is configured', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'claude-no-flag', registry }));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).not.toMatch(/(^|\s)--model(\s|$)/);
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
  });
});

describe('ClaudeCliHarness failure classification', () => {
  it('classifies usage_cap from stderr', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'quota exceeded', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.stderr).toBe('quota exceeded');
  });

  it('classifies killed exec as timeout', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('timeout');
  });

  it('classifies empty stdout as empty_response with exitCode 0', async () => {
    const harness = new ClaudeCliHarness(async () => ({ stdout: '   ', stderr: '' }));

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.details.exitCode).toBe(0);
  });

  it('preserves signal/killed/code in details when the exec error carries them', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.details.signal).toBe('SIGTERM');
    expect(err.details.killed).toBe(true);
  });
});
