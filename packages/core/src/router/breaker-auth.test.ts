// Regression for #3232: a rejected credential fails over, holds the provider's breaker open, and is announced once.

import { appendFileSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { authBreakerGate, providerFailureRecorder } from '../run/provider-failure-recorder.js';
import type { RunLogFn } from '../run/attribution.js';
import { logEvent } from '../utils/index.js';
import { ProviderBreaker } from './breaker.js';
import { credentialFingerprint } from './credential-fingerprint.js';
import { ModelRouter } from './index.js';

const entry = (provider: 'anthropic' | 'openai'): ModelsConfig['models'][string] => ({
  provider,
  tier: 'boss',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
});

const models: ModelsConfig = {
  version: 1,
  models: { 'claude-preferred': entry('anthropic'), 'gpt-fallback': { ...entry('openai'), codex: true } },
  tiers: { boss: ['claude-preferred', 'gpt-fallback'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

async function setup() {
  const dir = await tmp.make('breaker-auth-');
  const authFile = join(dir, '.credentials.json');
  await writeFile(authFile, '{"key":"one"}');
  const eventsFile = join(dir, 'events.ndjson');
  const runLog = join(dir, 'run.log');
  let t = 1_000_000;
  const fingerprint = (provider: string) =>
    credentialFingerprint(provider, { env: { CLAUDE_CONFIG_DIR: dir }, homedir: () => dir });
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => t, fingerprint);
  const log: RunLogFn = (type, msg, extra) => {
    logEvent(eventsFile, type, 3232, msg, extra);
    appendFileSync(runLog, `${type} ${msg}\n`);
  };
  const calls: string[] = [];
  const router = new ModelRouter(models, routes, false, {
    runModel: vi.fn(async (model: string) => {
      calls.push(model);
      if (model === 'claude-preferred') {
        throw new HarnessError('authentication_error: invalid x-api-key sk-ant-api03-SECRETSECRET', 'local_auth');
      }
      return 'FROM GPT';
    }),
  });
  router.setProviderGate(authBreakerGate({ breaker, log }));
  const run = () =>
    router.run('plan', 'do it', {
      modelOverride: 'claude-preferred',
      modelFallbacks: ['gpt-fallback'],
      onProviderFailure: providerFailureRecorder({ breaker, log, issue: 3232, defaultCooldownMs: 60_000 })('plan'),
    });
  const count = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('provider_auth_rejected')).length;
  return { run, breaker, calls, eventsFile, runLog, count, authFile, advance: (ms: number) => (t += ms) };
}

describe('rejected credential breaker (#3232)', () => {
  it('a rejected key opens an untimed breaker and one provider_auth_rejected event', async () => {
    const s = await setup();
    expect((await s.run()).model).toBe('gpt-fallback');
    expect((await s.run()).model).toBe('gpt-fallback');
    s.advance(48 * 60 * 60_000);

    const status = await s.breaker.status('anthropic');
    expect(status.open).toBe(true);
    if (!status.open) return;
    expect(status.entry.until).toBe('credentials-change');
    expect(status.entry.cooldownMs).toBe(0);
    expect(status.entry.cappedUntil).toBeUndefined();
    expect(s.count(s.eventsFile)).toBe(1);
    expect(s.count(s.runLog)).toBe(1);
    for (const file of [s.eventsFile, s.runLog]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('SECRETSECRET');
      expect(text).not.toContain('sk-ant');
    }
  });

  it('later runs skip an auth-open provider and write no further provider_auth_rejected', async () => {
    const s = await setup();
    await s.run();
    for (let i = 0; i < 3; i++) expect((await s.run()).model).toBe('gpt-fallback');
    expect(s.calls.filter((m) => m === 'claude-preferred')).toHaveLength(1);
    expect(s.count(s.eventsFile)).toBe(1);
  });
});
