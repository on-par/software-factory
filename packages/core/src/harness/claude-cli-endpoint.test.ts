import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from '../router/index.js';
import { ClaudeCliHarness, claudeEndpointEnv } from './claude-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {},
  tiers: { boss: [] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const envelope = () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OUT' });

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string; opts: any }[] = [];
  const fn = async (cmd: string, opts: any) => {
    calls.push({ cmd, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('ClaudeCliHarness intermediary endpoint (#2906)', () => {
  const base = {
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [] as string[],
  };
  const endpointDef: ModelsConfig['models'][string] = {
    ...base,
    provider: 'custom',
    harness: 'claude-cli',
    endpoint: 'https://openrouter.ai/api',
    envKey: 'OPENROUTER_API_KEY',
    claudeFlag: 'deepseek/deepseek-v4-flash',
  };
  const epConfig: ModelsConfig = {
    ...modelsConfig,
    models: {
      A: endpointDef,
      'claude-sonnet-5': { ...base, provider: 'anthropic', envKey: null, claudeFlag: 'claude-sonnet-5' },
      'no-flag': { ...endpointDef, claudeFlag: undefined },
    },
    tiers: { boss: ['A', 'claude-sonnet-5'] },
  };
  const epRegistry = new ModelRegistry(epConfig);

  afterEach(() => vi.unstubAllEnvs());

  it('scopes ANTHROPIC_* env to the endpoint model when both run through one CliModelExecutor', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const rec = recordingExec({ stdout: envelope() });
    const executor = new CliModelExecutor(rec.fn as any);
    const ctx = {
      worktree: '/tmp/wt',
      timeoutSeconds: 5,
      task: 'build' as const,
      registry: epRegistry,
      routesConfig: {} as any,
    };
    await executor.runModel('A', 'p', ctx);
    await executor.runModel('claude-sonnet-5', 'p', ctx);
    const a = rec.calls[0].opts.env;
    expect(a).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-123',
      ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek/deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek/deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek/deepseek-v4-flash',
    });
    expect('ANTHROPIC_API_KEY' in a).toBe(true);
    expect(a.ANTHROPIC_API_KEY).toBeUndefined();
    const s = rec.calls[1].opts.env ?? {};
    expect(s.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(s.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(s.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('never puts the token in the command string', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const rec = recordingExec({ stdout: envelope() });
    await new ClaudeCliHarness(rec.fn).run(makeContractRequest({ model: 'A', registry: epRegistry }));
    expect(rec.calls[0].cmd).not.toContain('sk-test-123');
  });

  it('throws unavailable naming the key when the envKey is unset', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const rec = recordingExec({ stdout: envelope() });
    const err = await new ClaudeCliHarness(rec.fn)
      .run(makeContractRequest({ model: 'A', registry: epRegistry }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('unavailable');
    expect(err.message).toContain('OPENROUTER_API_KEY');
    expect(rec.calls).toHaveLength(0);
  });

  it('keeps CLAUDE_CODE_EFFORT_LEVEL alongside the endpoint env', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const registry = new ModelRegistry({ ...epConfig, efforts: { A: 'high' } });
    const rec = recordingExec({ stdout: envelope() });
    await new ClaudeCliHarness(rec.fn).run(makeContractRequest({ model: 'A', registry }));
    expect(rec.calls[0].opts.env).toMatchObject({
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    });
  });

  it('omits model vars when the endpoint model has no claudeFlag', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const rec = recordingExec({ stdout: envelope() });
    await new ClaudeCliHarness(rec.fn).run(makeContractRequest({ model: 'no-flag', registry: epRegistry }));
    const env = rec.calls[0].opts.env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  const costEnvelope = (cost: number) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OUT',
      total_cost_usd: cost,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });

  it('omits total_cost_usd from usage for an endpoint model but keeps token counts (#2907)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const rec = recordingExec({ stdout: costEnvelope(9.99) });
    const result = await new ClaudeCliHarness(rec.fn).run(makeContractRequest({ model: 'A', registry: epRegistry }));
    expect(result.usage).not.toHaveProperty('costUsd');
    expect(result.usage?.inputTokens).toBe(1_000_000);
    expect(result.usage?.outputTokens).toBe(1_000_000);
  });

  it('keeps total_cost_usd as costUsd for a model with no endpoint (#2907)', async () => {
    const rec = recordingExec({ stdout: costEnvelope(0.42) });
    const result = await new ClaudeCliHarness(rec.fn).run(
      makeContractRequest({ model: 'claude-sonnet-5', registry: epRegistry }),
    );
    expect(result.usage?.costUsd).toBe(0.42);
  });

  it('claudeEndpointEnv returns {} without an endpoint and throws for a non-approved one', () => {
    expect(claudeEndpointEnv(undefined)).toEqual({});
    expect(claudeEndpointEnv({ envKey: null })).toEqual({});
    expect(() =>
      claudeEndpointEnv({ endpoint: 'https://api.deepseek.com/anthropic', envKey: 'K' }, { K: 'v' }),
    ).toThrow(/not an approved intermediary/);
  });
});
