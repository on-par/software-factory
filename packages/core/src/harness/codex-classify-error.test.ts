import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { providerFailureOf } from './provider-failure.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const modelsConfig: ModelsConfig = {
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
    'codex-no-flag': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
  },
  tiers: { boss: ['codex-model', 'codex-no-flag'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

const NOW = '2026-10-19T12:00:00Z';

function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

async function fail(stdout: string, stderr = '', now = NOW, timeZone = 'UTC') {
  const plain = { stdout, stderr, code: 1 };
  const harness = new CodexCliHarness(
    async () => {
      throw Object.assign(new Error('Command failed: codex exec'), plain);
    },
    {},
    { now: () => Date.parse(now), timeZone },
  );
  const err = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  return { harness, err: err as HarnessError, plain };
}

describe('CodexCliHarness.classifyError (#3227)', () => {
  it('a Codex usage-limit error reports usage_cap with the reset time', async () => {
    const stdout = jsonl({
      type: 'turn.failed',
      error: {
        message:
          "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 1 days 2 hours 5 minutes.",
      },
    });
    const { harness, err, plain } = await fail(stdout);
    expect(err.details.kind).toBe('usage_cap');
    expect(err.details.resetAt).toBe('2026-10-20T14:05:00.000Z');
    expect(providerFailureOf(err).resetAt).toBe('2026-10-20T14:05:00.000Z');
    expect(harness.classifyError(err)).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T14:05:00.000Z' });
    expect(harness.classifyError(plain)).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T14:05:00.000Z' });
  });

  it('resolves try again at 3:05 PM to the next Chicago wall-clock time', async () => {
    const stdout = jsonl({ type: 'error', message: "You've hit your usage limit. Try again at 3:05 PM." });
    const same = await fail(stdout, '', '2026-10-19T13:00:00Z', 'America/Chicago');
    expect(same.err.details.resetAt).toBe('2026-10-19T20:05:00.000Z');
    const rolled = await fail(stdout, '', '2026-10-19T21:00:00Z', 'America/Chicago');
    expect(rolled.err.details.resetAt).toBe('2026-10-20T20:05:00.000Z');
  });

  it('usage limit with no reset phrase reports usage_cap without resetAt', async () => {
    const stdout = jsonl({ type: 'error', message: "You've hit your usage limit." });
    const { harness, err, plain } = await fail(stdout);
    expect(err.details.kind).toBe('usage_cap');
    expect(err.details.resetAt).toBeUndefined();
    expect(harness.classifyError(plain)).toMatchObject({ kind: 'usage_cap' });
    expect(harness.classifyError(plain).resetAt).toBeUndefined();
  });

  it('ignores agent-message prose that mentions a usage limit and reset', async () => {
    const stdout = jsonl({
      type: 'item.completed',
      item: { type: 'agent_message', text: "You've hit your usage limit. try again in 2 hours" },
    });
    const { harness, err, plain } = await fail(stdout, 'boom error');
    expect(err.details.kind).not.toBe('usage_cap');
    expect(err.details.resetAt).toBeUndefined();
    const verdict = harness.classifyError(plain);
    expect(verdict.kind).not.toBe('usage_cap');
    expect(verdict.resetAt).toBeUndefined();
  });

  it('keeps tags on a tagged HarnessError and maps a killed plain error to timeout', () => {
    const harness = new CodexCliHarness();
    const tagged = new HarnessError('x', 'usage_cap', { kind: 'usage_cap', resetAt: '2026-10-20T00:00:00Z' });
    expect(harness.classifyError(tagged)).toMatchObject({ kind: 'usage_cap', resetAt: '2026-10-20T00:00:00.000Z' });
    expect(harness.classifyError({ killed: true }).reason).toBe('timeout');
    expect(harness.classifyError(null).kind).toBeDefined();
    expect(harness.classifyError('nope').kind).toBeDefined();
  });
});
