// Regression for #3232: a rejected credential opens an untimed breaker and writes one provider_auth_rejected.

import { readFileSync } from 'node:fs';
import { createTempDirs } from '@on-par/factory-core/testing';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { providerFallbackPreferrer } from '../run/provider-breaker-gate.js';
import { logEvent } from '../utils/index.js';
import { ProviderBreaker } from './breaker.js';
import { recordProviderFailure } from './breaker-record.js';
import { ModelRouter } from './index.js';

const routes: RoutesConfig = {
  version: 1,
  routes: { plan: { tier: 'boss', description: 'stub' } },
};

const model = {
  tier: 'boss',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
};

const models: ModelsConfig = {
  version: 1,
  models: {
    'claude-preferred': { ...model, provider: 'anthropic' },
    'gpt-fallback': { ...model, provider: 'openai', codex: true },
  },
  tiers: { boss: ['claude-preferred', 'gpt-fallback'] },
  failover: { triggers: ['error'], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: true },
  routingRules: {},
};

const SECRET = 'sk-ant-api03-SECRETSECRETSECRET';
const T0 = Date.parse('2026-10-20T00:00:00Z');

let tmp: string;
let events: string;
const tempDirs = createTempDirs();
let t: number;
let breaker: ProviderBreaker;
let router: ModelRouter;
let claudeCalls: number;

beforeEach(async () => {
  tmp = await tempDirs.make('breaker-auth-');
  events = join(tmp, 'events.ndjson');
  t = T0;
  claudeCalls = 0;
  breaker = new ProviderBreaker(join(tmp, 'breaker.json'), () => t, { fingerprint: async () => 'fp-1' });
  router = new ModelRouter(models, routes, false, {
    runModel: async (model: string) => {
      if (model === 'claude-preferred') {
        claudeCalls += 1;
        throw new HarnessError(`authentication_error: invalid x-api-key ${SECRET}`, 'local_auth');
      }
      return 'FROM GPT';
    },
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

const run = (model: string) =>
  router.run('plan', 'do it', {
    modelOverride: model,
    modelFallbacks: ['gpt-fallback'],
    onProviderFailure: (info) =>
      recordProviderFailure(
        {
          breaker,
          log: (type, msg, extra) => logEvent(events, type, 3232, msg, extra),
          issue: 3232,
          defaultCooldownMs: 60_000,
          now: () => t,
        },
        info,
      ),
  });

const rejectedEvents = (): Array<Record<string, unknown>> =>
  readFileSync(events, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === 'provider_auth_rejected');

describe('rejected credential breaker (#3232)', () => {
  it('a rejected key opens an untimed breaker and one provider_auth_rejected event', async () => {
    for (let i = 0; i < 2; i++) expect((await run('claude-preferred')).model).toBe('gpt-fallback');
    t += 48 * 60 * 60_000;

    const status = await breaker.status('anthropic');
    expect(status.open).toBe(true);
    if (!status.open) return;
    expect(status.entry).toMatchObject({ until: 'credentials-change' });
    expect('cooldownMs' in status.entry).toBe(false);

    const rejected = rejectedEvents();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].level).toBe('warn');
    expect(rejected[0].providerAuthRejected).toMatchObject({
      provider: 'anthropic',
      model: 'claude-preferred',
      stage: 'plan',
      issue: 3232,
    });
    expect(readFileSync(events, 'utf-8')).not.toContain('SECRETSECRET');
  });

  it('three more runs with the auth breaker open skip anthropic and write no further provider_auth_rejected', async () => {
    await run('claude-preferred');
    const skips: string[] = [];
    const prefer = providerFallbackPreferrer({
      router,
      breaker,
      log: (type, msg) => {
        if (type === 'provider_breaker_skip') skips.push(msg);
      },
    });
    for (let i = 0; i < 3; i++) {
      const model = await prefer('claude-preferred', 'gpt-fallback', 'plan');
      expect(model).toBe('gpt-fallback');
      expect((await run(model ?? '')).model).toBe('gpt-fallback');
    }
    expect(skips).toHaveLength(3);
    expect(skips[0]).toContain('until credentials change');
    expect(claudeCalls).toBe(1);
    expect(rejectedEvents()).toHaveLength(1);
  });
});
