import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const sandboxPolicy: SandboxPolicy = {
  runtime: 'sandbox-exec',
  worktree: '/tmp/factory worktree',
  writablePaths: ['/tmp/factory worktree'],
  allowHosts: [],
  cpuMs: 300_000,
  memMb: 4096,
};

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

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'CLAUDE OUTPUT',
    total_cost_usd: 0.0123,
    num_turns: 42,
    duration_ms: 2030000,
    duration_api_ms: 1900000,
    usage: { input_tokens: 12, cache_creation_input_tokens: 4500, cache_read_input_tokens: 230000, output_tokens: 890 },
    ...over,
  });

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
    expect(rec.calls[0].cmd).toContain('--output-format json');
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
    expect(rec.calls[0].cmd).toMatch(/--dangerously-skip-permissions\s*< \/dev\/null$/);
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

  it('forwards request.env verbatim to the execFn opts', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    await harness.run(
      makeContractRequest({
        model: 'claude-model',
        registry,
        env: { PORT: '3142', FACTORY_APP_PORT: '3142', FACTORY_BASE_URL: 'http://127.0.0.1:3142' },
      }),
    );

    expect(rec.calls[0].opts.env).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('leaves opts.env undefined when the request has no env', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(rec.calls[0].opts.env).toBeUndefined();
  });

  it('forwards request.onPgid to the execFn opts', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);
    const onPgid = () => {};

    await harness.run(makeContractRequest({ model: 'claude-model', registry, onPgid }));

    expect(rec.calls[0].opts.onPgid).toBe(onPgid);
  });

  it('wraps the invocation in sandbox-exec when request.sandbox is set', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    await harness.run(
      makeContractRequest({ model: 'claude-model', registry, prompt: 'draft plan', sandbox: sandboxPolicy }),
    );

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd.startsWith('sandbox-exec -p ')).toBe(true);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
  });
});

describe('ClaudeCliHarness result-envelope usage parsing', () => {
  it('parses usage and total_cost_usd from a well-formed envelope', async () => {
    const rec = recordingExec({ stdout: envelope() });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.output).toBe('CLAUDE OUTPUT');
    expect(result.usage).toEqual({
      inputTokens: 12 + 4500 + 230000,
      outputTokens: 890,
      rawInputTokens: 12,
      cacheReadTokens: 230000,
      cacheCreationTokens: 4500,
      numTurns: 42,
      durationMs: 2030000,
      durationApiMs: 1900000,
      costUsd: 0.0123,
    });
  });

  it('omits numTurns/durationMs/durationApiMs when the envelope lacks them, but still parses tokens', async () => {
    const rec = recordingExec({
      stdout: envelope({ num_turns: undefined, duration_ms: undefined, duration_api_ms: undefined }),
    });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.usage).toEqual({
      inputTokens: 12 + 4500 + 230000,
      outputTokens: 890,
      rawInputTokens: 12,
      cacheReadTokens: 230000,
      cacheCreationTokens: 4500,
      costUsd: 0.0123,
    });
    expect(result.usage).not.toHaveProperty('numTurns');
    expect(result.usage).not.toHaveProperty('durationMs');
    expect(result.usage).not.toHaveProperty('durationApiMs');
  });

  it('omits non-finite telemetry fields while still parsing tokens', async () => {
    const rec = recordingExec({ stdout: envelope({ num_turns: 'lots' }) });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.usage).not.toHaveProperty('numTurns');
    expect(result.usage?.durationMs).toBe(2030000);
    expect(result.usage?.durationApiMs).toBe(1900000);
  });

  it('falls back to the older cost_usd field when total_cost_usd is absent', async () => {
    const withOlderCostField = JSON.parse(envelope());
    delete withOlderCostField.total_cost_usd;
    withOlderCostField.cost_usd = 0.05;
    const rec = recordingExec({ stdout: JSON.stringify(withOlderCostField) });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.usage?.costUsd).toBe(0.05);
  });

  it('returns output with no usage when the usage block is absent', async () => {
    const rec = recordingExec({ stdout: envelope({ usage: undefined }) });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.output).toBe('CLAUDE OUTPUT');
    expect(result.usage).toBeUndefined();
  });

  it('returns output with no usage when the usage block is malformed', async () => {
    const rec = recordingExec({
      stdout: envelope({ usage: { input_tokens: 'many', output_tokens: 890 } }),
    });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.output).toBe('CLAUDE OUTPUT');
    expect(result.usage).toBeUndefined();
  });

  it('falls back to raw stdout as output when stdout is not JSON', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const harness = new ClaudeCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'claude-model', registry }));

    expect(result.output).toBe('CLAUDE OUTPUT');
    expect(result.usage).toBeUndefined();
  });

  it('rejects with empty_response when the envelope result is an empty string', async () => {
    const rec = recordingExec({ stdout: envelope({ result: '' }) });
    const harness = new ClaudeCliHarness(rec.fn);

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.details.exitCode).toBe(0);
  });

  it('rejects with reason error when the envelope reports is_error: true, even with a non-empty result', async () => {
    const rec = recordingExec({
      stdout: envelope({ is_error: true, subtype: 'error_max_turns', result: 'partial output before max turns' }),
    });
    const harness = new ClaudeCliHarness(rec.fn);

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('error');
    expect(err.message).toContain('error_max_turns');
    expect(err.details.exitCode).toBe(0);
    expect(err.details.stdout).toBe('partial output before max turns');
  });

  it('classifies a zero-token, zero-API-duration error envelope as unavailable', async () => {
    const rec = recordingExec({
      stdout: envelope({
        is_error: true,
        subtype: 'error_during_execution',
        result: 'provider did not start',
        duration_api_ms: 0,
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
    });
    const harness = new ClaudeCliHarness(rec.fn);

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('unavailable');
    expect(err.message).toContain('zero-token');
    expect(err.details.stdout).toBe('provider did not start');
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

  it('captures stdout in HarnessError details when the exec error carries it', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('boom'), {
        stdout: 'Invalid API key · Please run /login',
        stderr: '',
        code: 1,
      });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.details.stdout).toBe('Invalid API key · Please run /login');
  });

  it('omits stdout from details when the exec error carries none', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.details.stdout).toBeUndefined();
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
