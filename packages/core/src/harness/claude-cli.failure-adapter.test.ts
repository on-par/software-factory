import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);

describe('ClaudeCliHarness provider failure adapter', () => {
  const NOW = Date.parse('2026-10-18T22:39:00Z');
  const WEEKLY = "You've hit your weekly limit · resets Oct 20 at 7am (America/Chicago)";
  const envelope = (result: string, usage: { in: number; out: number; api: number }) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result,
      duration_api_ms: usage.api,
      usage: { input_tokens: usage.in, output_tokens: usage.out },
    });

  it('classifies the exit-0 weekly-limit is_error result as usage_cap with resetAt (incident fixture)', async () => {
    const harness = new ClaudeCliHarness(
      async () => ({ stdout: envelope(WEEKLY, { in: 5, out: 5, api: 100 }), stderr: '' }),
      () => NOW,
    );
    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.kind).toBe('usage_cap');
    expect(err.details.resetAt).toBe('2026-10-20T12:00:00.000Z');
    expect(harness.classifyError(err)).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T12:00:00.000Z' });
  });

  it('resolves a 5-hour `resets 7am (zone)` to the next 7am after now', async () => {
    const harness = new ClaudeCliHarness(
      async () => {
        throw Object.assign(new Error('boom'), {
          stderr: "You've hit your limit · resets 7am (America/Chicago)",
          code: 1,
        });
      },
      () => Date.parse('2026-10-19T13:00:00Z'),
    );
    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);
    expect(err.reason).toBe('usage_cap');
    expect(err.details).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T12:00:00.000Z' });
  });

  it('keeps a zero-token is_error result with no limit text as unavailable', async () => {
    const harness = new ClaudeCliHarness(
      async () => ({ stdout: envelope('', { in: 0, out: 0, api: 0 }), stderr: '' }),
      () => NOW,
    );
    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);
    expect(err.reason).toBe('unavailable');
    expect(err.details.kind).toBe('unavailable');
    expect(err.message).toContain('zero-token');
  });

  it('tags a killed exec as timeout and classifies untagged errors from their text', async () => {
    const harness = new ClaudeCliHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });
    const err: any = await harness.run(makeContractRequest({ model: 'claude-model', registry })).catch((e) => e);
    expect(err.details.kind).toBe('unavailable');
    expect(harness.classifyError(new HarnessError('x', 'error', { stderr: 'quota exceeded' })).reason).toBe(
      'usage_cap',
    );
    expect(harness.classifyError(new Error('plain')).reason).toBe('unknown');
  });
});
