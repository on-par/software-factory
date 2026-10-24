import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderRestoredPayload } from '../events/payloads.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { PROBE_CLAIM_STALE_MS, ProviderBreaker, RESET_BUFFER_MS } from './breaker.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const CAPPED_UNTIL = '2026-10-20T12:00:00.000Z';
const T_0630 = Date.parse('2026-10-20T11:30:00Z');
const T_0705 = Date.parse('2026-10-20T12:05:00Z');

async function setup() {
  const dir = await tempDirs.make('breaker-probe-test-');
  const closed: ProviderRestoredPayload[] = [];
  const clock = { t: T_0630 };
  const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => clock.t, { onClose: (r) => closed.push(r) });
  return { breaker, clock, closed };
}

describe('ProviderBreaker restore probe (#3339)', () => {
  it('probeDue is undefined until cappedUntil passes, and for non-cap entries', async () => {
    const { breaker, clock } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    await breaker.open('openai', 'rate_limit', 30 * 60_000);
    await breaker.openUntilCredentialsChange('custom', 'local_auth');
    expect(await breaker.probeDue('anthropic')).toBeUndefined();
    clock.t = T_0705;
    expect((await breaker.probeDue('anthropic'))?.cappedUntil).toBe(CAPPED_UNTIL);
    expect(await breaker.probeDue('openai')).toBeUndefined();
    expect(await breaker.probeDue('custom')).toBeUndefined();
    expect(await breaker.probeDue('nobody')).toBeUndefined();
    expect(await breaker.claimProbe('openai')).toBe('not-due');
  });

  it('closeAfterProbe prunes the entry and reports cause probe', async () => {
    const { breaker, clock, closed } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    clock.t = T_0705;
    expect(await breaker.claimProbe('anthropic')).toBe('claimed');
    await breaker.closeAfterProbe('anthropic');
    expect(closed).toEqual([{ provider: 'anthropic', at: '2026-10-20T12:05:00.000Z', cause: 'probe' }]);
    expect(await breaker.status('anthropic')).toEqual({ open: false });
    expect(await breaker.claimProbe('anthropic')).toBe('not-due');
  });

  it('recapAfterProbe re-caps for 1h with no reset, or to the reported reset plus the buffer', async () => {
    const { breaker, clock, closed } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    clock.t = T_0705;
    expect(await breaker.recapAfterProbe('anthropic')).toEqual({ cappedUntil: '2026-10-20T13:05:00.000Z' });
    expect((await breaker.status('anthropic')).open).toBe(true);
    expect((await breaker.probeDue('anthropic'))?.probeDue).toBeUndefined();
    const reported = await breaker.recapAfterProbe('anthropic', { reason: 'usage_cap', detail: 'Resets in 2hr' });
    expect(Date.parse(reported.cappedUntil)).toBe(T_0705 + 2 * 60 * 60_000 + RESET_BUFFER_MS);
    expect(closed).toEqual([]);
  });

  it('a recapped cap can be claimed and probed again once it passes', async () => {
    const { breaker, clock } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    clock.t = T_0705;
    await breaker.claimProbe('anthropic');
    await breaker.recapAfterProbe('anthropic');
    clock.t = T_0705 + 61 * 60_000;
    expect(await breaker.claimProbe('anthropic')).toBe('claimed');
  });

  it('a stale claim no longer holds the past-due cap open', async () => {
    const { breaker, clock } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    clock.t = T_0705;
    expect(await breaker.claimProbe('anthropic')).toBe('claimed');
    expect(await breaker.claimProbe('anthropic')).toBe('taken');
    clock.t = T_0705 + PROBE_CLAIM_STALE_MS + 1;
    expect((await breaker.status('anthropic')).open).toBe(false);
  });

  it('a stale claim is reclaimable by claimProbe', async () => {
    const { breaker, clock } = await setup();
    await breaker.open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    clock.t = T_0705;
    await breaker.claimProbe('anthropic');
    clock.t = T_0705 + PROBE_CLAIM_STALE_MS + 1;
    expect(await breaker.claimProbe('anthropic')).toBe('claimed');
  });
});
