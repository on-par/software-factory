import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderBreaker } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';

import { runBreakerReset } from './breaker.js';

const temp = createTempDirs();

describe('runBreakerReset', () => {
  it('breaker reset removes an open entry and logs provider_breaker_close cause manual_reset', async () => {
    const dir = await temp.make('breaker-reset-');
    const breakerFile = join(dir, 'breaker.json');
    const eventsFile = join(dir, 'events.ndjson');
    const breaker = new ProviderBreaker(breakerFile);
    await breaker.openUntilCredentialsChange('anthropic', 'local_auth');

    const result = await runBreakerReset({ breakerFile, eventsFile, provider: 'anthropic' });

    expect(result).toMatchObject({
      ok: true,
      provider: 'anthropic',
      entry: { reason: 'local_auth', until: 'credentials-change' },
    });
    expect((await breaker.status('anthropic')).open).toBe(false);
    const line = JSON.parse(readFileSync(eventsFile, 'utf-8').trim().split('\n')[0]);
    expect(line.type).toBe('provider_breaker_close');
    expect(line.breakerClose).toEqual({ provider: 'anthropic', cause: 'manual_reset' });
  });

  it('lists the open providers when the named one has no open breaker', async () => {
    const dir = await temp.make('breaker-reset-');
    const breakerFile = join(dir, 'breaker.json');
    const eventsFile = join(dir, 'events.ndjson');
    await new ProviderBreaker(breakerFile).open('openai', 'rate_limit', 60 * 60_000);

    expect(await runBreakerReset({ breakerFile, eventsFile, provider: 'anthropic' })).toEqual({
      ok: false,
      provider: 'anthropic',
      open: ['openai'],
    });
    expect(await runBreakerReset({ breakerFile: join(dir, 'none.json'), eventsFile, provider: 'x' })).toEqual({
      ok: false,
      provider: 'x',
      open: [],
    });
  });
});
