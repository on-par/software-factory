import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderBreaker } from '../router/breaker.js';
import { authBreakerGate, providerFailureRecorder } from './provider-failure-recorder.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(fp: () => string = () => 'fp') {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-'));
  dirs.push(dir);
  const breaker = new ProviderBreaker(
    join(dir, 'breaker.json'),
    () => 0,
    async () => fp(),
  );
  const logs: Array<{ type: string; extra?: Record<string, unknown> }> = [];
  const log = (type: string, _msg: string, extra?: Record<string, unknown>) => logs.push({ type, extra });
  return { breaker, logs, log: log as never };
}

describe('providerFailureRecorder auth path (#3232)', () => {
  it('opens an auth breaker, logs provider_auth_rejected once across two calls, and redacts the detail', async () => {
    const { breaker, logs, log } = await setup();
    const record = providerFailureRecorder({ breaker, log, issue: 1, defaultCooldownMs: 1000 })('plan');
    const info = {
      provider: 'anthropic',
      reason: 'local_auth' as const,
      kind: 'auth' as const,
      model: 'claude-x',
      harness: 'claude-cli',
      detail: 'invalid x-api-key sk-ant-api03-SECRETSECRET',
    };
    await record(info);
    await record(info);
    const rejected = logs.filter((l) => l.type === 'provider_auth_rejected');
    expect(rejected).toHaveLength(1);
    const payload = JSON.stringify(rejected[0].extra);
    expect(payload).not.toContain('SECRETSECRET');
    expect(rejected[0].extra?.providerAuthRejected).toMatchObject({
      provider: 'anthropic',
      harness: 'claude-cli',
      model: 'claude-x',
      stage: 'plan',
      issue: 1,
    });
    expect((await breaker.status('anthropic')).open).toBe(true);
  });
});

describe('authBreakerGate', () => {
  it('gates an open auth entry, then logs provider_breaker_close creds_changed once credentials change', async () => {
    let fp = 'one';
    const { breaker, logs, log } = await setup(() => fp);
    await breaker.openAuth('anthropic', 'local_auth');
    const gate = authBreakerGate({ breaker, log });
    expect(await gate('anthropic')).toBe(true);
    expect(await gate('openai')).toBe(false);
    fp = 'two';
    expect(await gate('anthropic')).toBe(false);
    expect(logs).toEqual([
      {
        type: 'provider_breaker_close',
        extra: { providerBreakerClose: { provider: 'anthropic', cause: 'creds_changed' } },
      },
    ]);
  });

  it('does not gate a timed entry', async () => {
    const { breaker, log } = await setup();
    await breaker.open('openai', 'rate_limit', 1000);
    expect(await authBreakerGate({ breaker, log })('openai')).toBe(false);
  });
});
