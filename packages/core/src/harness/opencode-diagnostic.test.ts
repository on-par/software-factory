import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { describeFailureDetail } from '../router/failure-detail.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { OpenCodeHarness } from './opencode.js';

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
  },
  tiers: { boss: ['opencode-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/opencode/${name}`, import.meta.url)), 'utf8');
const capFixture = readFixture('error-usage-cap.jsonl');
const rateLimitFixture = readFixture('error-rate-limit.jsonl');

describe('OpenCodeHarness recorded error fixtures', () => {
  const runFailing = (stdout: string) =>
    new OpenCodeHarness(async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: '', stdout });
    })
      .run(makeContractRequest({ model: 'opencode-model', registry }))
      .catch((e) => e);

  it('keeps the error event text in details.diagnostic on a non-zero exit', async () => {
    const err: any = await runFailing(capFixture);
    expect(err.details.diagnostic).toContain('OpenCode Go monthly usage limit reached');
  });

  it('describeFailureDetail renders the error event text as diagnostic', async () => {
    const err: any = await runFailing(capFixture);
    const line = describeFailureDetail(err);
    expect(line).toContain('diagnostic=');
    expect(line).toContain('resets at 2026-11-01T00:00:00Z');
  });

  it('keeps the error event text in details.diagnostic on exit 0', async () => {
    const err: any = await new OpenCodeHarness(async () => ({ stdout: rateLimitFixture, stderr: '' }))
      .run(makeContractRequest({ model: 'opencode-model', registry }))
      .catch((e) => e);
    expect(err.details.diagnostic).toContain('status 429');
    expect(err.details.exitCode).toBe(0);
  });

  it('omits diagnostic when stdout has no error event', async () => {
    const err: any = await runFailing('');
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.details).not.toHaveProperty('diagnostic');
  });
});
