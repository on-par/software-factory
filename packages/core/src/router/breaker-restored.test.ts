import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderRestoredPayload } from '../events/payloads.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ProviderBreaker, restoredCause } from './breaker.js';

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

async function tmpFile(): Promise<string> {
  const dir = await tempDirs.make('breaker-restored-test-');
  return join(dir, 'breaker.json');
}

describe('provider_restored: onClose fires once per close with creds_changed, manual_reset or timed_reset', () => {
  const T0 = Date.parse('2026-10-23T00:00:00Z');

  it('restoredCause maps cooldown to timed_reset', () => {
    expect(restoredCause('cooldown')).toBe('timed_reset');
    expect(restoredCause('creds_changed')).toBe('creds_changed');
    expect(restoredCause('manual_reset')).toBe('manual_reset');
    expect(restoredCause('probe')).toBe('probe');
  });

  it('fires timed_reset once when the cooldown ends', async () => {
    const closed: ProviderRestoredPayload[] = [];
    let clock = T0;
    const breaker = new ProviderBreaker(await tmpFile(), () => clock, { onClose: (r) => closed.push(r) });
    await breaker.open('anthropic', 'usage_cap', 60_000);
    await breaker.status('anthropic');
    await breaker.list();
    expect(closed).toEqual([]);
    clock = T0 + 61_000;
    await breaker.status('anthropic');
    await breaker.status('anthropic');
    expect(closed).toEqual([{ provider: 'anthropic', at: new Date(clock).toISOString(), cause: 'timed_reset' }]);
  });

  it('fires creds_changed once when the fingerprint changes', async () => {
    const closed: ProviderRestoredPayload[] = [];
    let fp = 'a';
    const breaker = new ProviderBreaker(await tmpFile(), () => T0, {
      fingerprint: () => fp,
      onClose: (r) => closed.push(r),
    });
    await breaker.openUntilCredentialsChange('anthropic', 'local_auth');
    await breaker.status('anthropic');
    fp = 'b';
    await breaker.status('anthropic');
    await breaker.status('anthropic');
    expect(closed).toEqual([{ provider: 'anthropic', at: new Date(T0).toISOString(), cause: 'creds_changed' }]);
  });

  it('fires manual_reset once, and not when there was no entry', async () => {
    const closed: ProviderRestoredPayload[] = [];
    const breaker = new ProviderBreaker(await tmpFile(), () => T0, { onClose: (r) => closed.push(r) });
    await breaker.open('anthropic', 'usage_cap', 60_000);
    await breaker.reset('anthropic');
    await breaker.reset('anthropic');
    expect(closed).toEqual([{ provider: 'anthropic', at: new Date(T0).toISOString(), cause: 'manual_reset' }]);
  });

  it('swallows an onClose that throws', async () => {
    let clock = T0;
    const breaker = new ProviderBreaker(await tmpFile(), () => clock, {
      onClose: () => {
        throw new Error('log failed');
      },
    });
    await breaker.open('anthropic', 'usage_cap', 1_000);
    clock = T0 + 2_000;
    expect(await breaker.status('anthropic')).toMatchObject({ open: false, closeCause: 'cooldown' });
  });
});
