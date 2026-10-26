import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker } from '../router/breaker.js';
import type { RunLogFn } from './attribution.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { providerFailureRecorder } from './provider-failure-recorder.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

async function setup() {
  const dir = await tmp.make('recorder-test-');
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => 1, { fingerprint: () => 'fp' });
  const logs: Array<{ type: string; extra?: Parameters<RunLogFn>[2] }> = [];
  const log: RunLogFn = (type, _msg, extra) => logs.push({ type, extra });
  const record = providerFailureRecorder({
    breaker,
    log,
    issue: workKeyFromIssue(7),
    defaultCooldownMs: 1000,
    now: () => 0,
  })('plan');
  return { breaker, logs, record };
}

describe('providerFailureRecorder kind auth (#3232)', () => {
  it('opens an untimed breaker and logs provider_auth_rejected once with a redacted detail', async () => {
    const { breaker, logs, record } = await setup();
    const info = {
      provider: 'anthropic',
      reason: 'local_auth' as const,
      kind: 'auth' as const,
      detail: 'invalid x-api-key sk-ant-abcdef123456',
      model: 'm',
      harness: 'claude-cli',
    };
    await record(info);
    await record(info);
    expect((await breaker.status('anthropic')).open).toBe(true);
    const rejected = logs.filter((l) => l.type === 'provider_auth_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].extra?.providerAuthRejected).toMatchObject({
      provider: 'anthropic',
      harness: 'claude-cli',
      model: 'm',
      stage: 'plan',
      issue: 7,
      at: new Date(0).toISOString(),
    });
    expect(JSON.stringify(rejected[0].extra)).not.toContain('sk-ant-abcdef123456');
    expect(logs.filter((l) => l.type === 'provider_breaker_open')).toHaveLength(2);
  });

  it('defaults model and harness to empty strings', async () => {
    const { logs, record } = await setup();
    await record({ provider: 'openai', reason: 'local_auth', kind: 'auth' });
    expect(logs.find((l) => l.type === 'provider_auth_rejected')?.extra?.providerAuthRejected).toMatchObject({
      model: '',
      harness: '',
      detail: '',
    });
  });
});
