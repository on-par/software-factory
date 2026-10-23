// Regression for #3232: a rejected credential fails over, holds the breaker until the credentials change, and
// announces itself with exactly one provider_auth_rejected event.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { providerFailureRecorder } from '../run/provider-failure-recorder.js';
import { logEvent } from '../utils/index.js';
import { ProviderBreaker } from './breaker.js';
import { ModelRouter } from './index.js';

const FAKE_KEY = 'sk-ant-api03-FAKEKEYMATERIAL1234567890';

const entry = (provider: 'anthropic' | 'openai') => ({
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
  models: { 'claude-a': entry('anthropic'), 'gpt-b': { ...entry('openai'), codex: true } },
  tiers: { boss: ['claude-a', 'gpt-b'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

async function setup(anthropicError: string) {
  const dir = await tmp.make('breaker-auth-');
  const clock = { now: Date.parse('2026-10-20T00:00:00Z') };
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => clock.now, { fingerprint: () => 'fp' });
  const eventsFile = join(dir, 'events.ndjson');
  const runLog: Array<{ type: string; extra?: unknown }> = [];
  const calls: string[] = [];
  const executor = {
    runModel: async (model: string) => {
      calls.push(model);
      if (model === 'claude-a') throw new HarnessError(anthropicError, 'local_auth');
      return 'ok';
    },
  };
  const router = new ModelRouter(models, routes, false, executor);
  const record = providerFailureRecorder({
    breaker,
    issue: 3232,
    defaultCooldownMs: 1000,
    log: (type, msg, extra) => {
      runLog.push({ type, extra });
      logEvent(eventsFile, type, '-', msg, extra);
    },
  })('plan');
  const run = () => router.run('plan', 'p', { onProviderFailure: record });
  return { dir, clock, breaker, eventsFile, runLog, calls, router, run };
}

const countRejected = (runLog: Array<{ type: string }>) =>
  runLog.filter((l) => l.type === 'provider_auth_rejected').length;

describe('rejected credential holds the breaker (#3232)', () => {
  it('a rejected key opens an untimed breaker and one provider_auth_rejected event', async () => {
    const t = await setup(`authentication_error: invalid x-api-key ${FAKE_KEY}`);
    // The rejected key ends the first call (no mid-call move to openai, #3228); later runs skip the tripped harness.
    await expect(t.run()).rejects.toMatchObject({ reason: 'local_auth' });
    expect((await t.run()).model).toBe('gpt-b');
    t.clock.now += 48 * 3_600_000;

    const status = await t.breaker.status('anthropic');
    expect(status.open).toBe(true);
    if (!status.open) throw new Error('unreachable');
    expect(status.entry.until).toBe('credentials-change');
    expect(status.entry.cappedUntil).toBeUndefined();

    const events = (await readFile(t.eventsFile, 'utf-8'))
      .trim()
      .split('\n')
      .filter((l) => l.includes('provider_auth_rejected'));
    expect(events).toHaveLength(1);
    expect(countRejected(t.runLog)).toBe(1);
    expect(events[0]).toContain('"provider":"anthropic"');
    expect(events[0]).toContain('"model":"claude-a"');
    expect(events[0]).toContain('"stage":"plan"');
    expect(events[0]).toContain('"harness"');
    expect(await readFile(t.eventsFile, 'utf-8')).not.toContain(FAKE_KEY);
    expect(await readFile(join(t.dir, 'breaker.json'), 'utf-8')).not.toContain(FAKE_KEY);
  });

  it('an open auth breaker skips anthropic on three more runs and writes no further provider_auth_rejected', async () => {
    const t = await setup('authentication_error: invalid x-api-key');
    await t.run().catch(() => undefined);
    t.router.setProviderHold(async (p) => {
      const s = await t.breaker.status(p);
      return s.open && s.entry.until === 'credentials-change';
    });
    t.calls.length = 0;
    for (let i = 0; i < 3; i++) expect((await t.run()).model).toBe('gpt-b');
    expect(t.calls.filter((m) => m === 'claude-a')).toEqual([]);
    expect(countRejected(t.runLog)).toBe(1);
  });

  it('treats a throwing hold as not held, and clears with undefined', async () => {
    const t = await setup('authentication_error: invalid x-api-key');
    t.router.setProviderHold(async () => {
      throw new Error('boom');
    });
    await t.run().catch(() => undefined);
    expect(t.calls).toContain('claude-a');
    const fresh = await setup('authentication_error: invalid x-api-key');
    fresh.router.setProviderHold(async () => true);
    fresh.router.setProviderHold(undefined);
    await fresh.run().catch(() => undefined);
    expect(fresh.calls).toContain('claude-a');
  });

  describe('signed-out', () => {
    it.each(['Please run /login', 'No auth credentials found'])('%s opens no auth breaker', async (text) => {
      const t = await setup(text);
      await expect(t.run()).rejects.toMatchObject({ reason: 'local_auth' });
      expect(countRejected(t.runLog)).toBe(0);
      expect(await readFile(join(t.dir, 'breaker.json'), 'utf-8').catch(() => '{}')).not.toContain(
        'credentials-change',
      );
    });
  });
});
