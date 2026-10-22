import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';
import { providerFailureOf } from './provider-failure.js';

const registry = new ModelRegistry({
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
      codexFlag: '--model gpt-5-codex',
    },
  },
  tiers: { boss: ['codex-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
} satisfies ModelsConfig);

describe('CodexCliHarness.classifyError (#3227)', () => {
  const NOW = '2026-10-19T12:00:00Z';
  const limitEvent =
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 1 days 2 hours 5 minutes."}}';
  const execError = (stdout: string, stderr = '') => Object.assign(new Error('boom'), { stderr, code: 1, stdout });
  const harnessAt = (now: string, timeZone = 'UTC', err?: unknown) =>
    new CodexCliHarness(
      err === undefined
        ? undefined
        : async () => {
            throw err;
          },
      {},
      { now: () => Date.parse(now), timeZone },
    );

  it('a Codex usage-limit error reports usage_cap with the reset time', () => {
    expect(harnessAt(NOW).classifyError(execError(limitEvent))).toMatchObject({
      kind: 'usage_cap',
      resetAt: '2026-10-20T14:05:00.000Z',
    });
  });

  it('an absolute try-again-at time resolves to the next local time in the box zone', () => {
    const stdout = '{"type":"error","message":"You\'ve hit your usage limit. try again at 3:05 PM"}';
    expect(harnessAt(NOW, 'America/Chicago').classifyError(execError(stdout)).resetAt).toBe('2026-10-19T20:05:00.000Z');
    expect(harnessAt('2026-10-19T21:00:00Z', 'America/Chicago').classifyError(execError(stdout)).resetAt).toBe(
      '2026-10-20T20:05:00.000Z',
    );
  });

  it('a Codex usage-limit error with no reset phrase reports usage_cap without resetAt', () => {
    const failure = harnessAt(NOW).classifyError(
      execError('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'),
    );
    expect(failure.kind).toBe('usage_cap');
    expect(failure.resetAt).toBeUndefined();
  });

  it('classifyError ignores agent transcript text that mentions a usage limit', () => {
    const stdout =
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"you\'ve hit your usage limit, try again in 2 hours"}}';
    const failure = harnessAt(NOW).classifyError(execError(stdout));
    expect(failure.kind).toBe('unavailable');
    expect(failure.reason).toBe('unknown');
    expect(failure.resetAt).toBeUndefined();
  });

  it('run() tags kind and resetAt on the thrown HarnessError', async () => {
    const harness = harnessAt(NOW, 'UTC', execError(limitEvent));
    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);
    expect(err.details.kind).toBe('usage_cap');
    expect(err.details.resetAt).toBe('2026-10-20T14:05:00.000Z');
    expect(providerFailureOf(err)).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T14:05:00.000Z' });
  });

  it('the login failure classifies as kind auth', async () => {
    const harness = harnessAt(NOW, 'UTC', execError('', 'unexpected status 401 Unauthorized: Missing bearer'));
    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);
    expect(err.details.kind).toBe('auth');
    expect(harness.classifyError(err).kind).toBe('auth');
  });

  it('a rate-limit event reports rate_limit', () => {
    const stdout = '{"type":"turn.failed","error":{"message":"stream error: rate limit exceeded"}}';
    expect(harnessAt(NOW).classifyError(execError(stdout)).kind).toBe('rate_limit');
  });

  it('classifies killed exec as timeout and tolerates non-error values', () => {
    const harness = harnessAt(NOW);
    expect(harness.classifyError(Object.assign(new Error('k'), { killed: true })).reason).toBe('timeout');
    expect(harness.classifyError(null).reason).toBe('unknown');
    expect(harness.classifyError('oops').reason).toBe('unknown');
  });
});
