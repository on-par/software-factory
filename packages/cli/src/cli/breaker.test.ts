import { join } from 'node:path';

import { ProviderBreaker } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { runBreakerReset } from './breaker.js';
import { CliExitError } from './index.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

async function setup() {
  const dir = await tmp.make('cli-breaker-');
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => 1, { fingerprint: () => 'fp' });
  const logs: unknown[] = [];
  const out: string[] = [];
  return {
    breaker,
    logs,
    out,
    deps: { breaker, log: (...a: unknown[]) => logs.push(a), out: (l: string) => out.push(l) },
  };
}

describe('runBreakerReset', () => {
  it('removes an open entry and logs provider_breaker_close manual_reset', async () => {
    const { breaker, logs, out, deps } = await setup();
    await breaker.openUntilCredentialsChange('anthropic', 'local_auth');
    await runBreakerReset('anthropic', deps);
    expect(await breaker.status('anthropic')).toEqual({ open: false });
    expect(logs).toEqual([
      [
        'provider_breaker_close',
        expect.any(String),
        { providerBreakerClose: { provider: 'anthropic', cause: 'manual_reset' } },
      ],
    ]);
    expect(out).toEqual(['reset the anthropic breaker (local_auth)']);
  });

  it('exits 1 listing the open providers when the provider has no entry', async () => {
    const { breaker, deps } = await setup();
    await breaker.openUntilCredentialsChange('openai', 'local_auth');
    const err = await runBreakerReset('anthropic', deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).message).toContain('open: openai');
    expect((err as CliExitError).code).toBe(1);
  });

  it('prints (none) when nothing is open', async () => {
    const { deps } = await setup();
    await expect(runBreakerReset('anthropic', deps)).rejects.toThrow('open: (none)');
  });
});
