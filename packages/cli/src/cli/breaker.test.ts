import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ProviderBreaker } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { cmdBreakerReset } from './breaker.js';
import { CliExitError } from './index.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

async function setup() {
  const dir = await tmp.make('cli-breaker-');
  const breakerFile = join(dir, 'breaker.json');
  const eventsFile = join(dir, 'events.ndjson');
  const lines: string[] = [];
  return { breakerFile, eventsFile, deps: { breakerFile, eventsFile, out: (l: string) => lines.push(l) }, lines };
}

describe('cmdBreakerReset (#3232)', () => {
  it('breaker reset removes an open entry and logs provider_breaker_close manual_reset', async () => {
    const s = await setup();
    const breaker = new ProviderBreaker(s.breakerFile, undefined, async () => 'fp');
    await breaker.openAuth('anthropic', 'local_auth');
    await cmdBreakerReset('anthropic', s.deps);
    expect(await breaker.list()).toEqual([]);
    const event = JSON.parse((await readFile(s.eventsFile, 'utf8')).trim().split('\n')[0]) as {
      type: string;
      providerBreakerClose: { cause: string };
    };
    expect(event.type).toBe('provider_breaker_close');
    expect(event.providerBreakerClose.cause).toBe('manual_reset');
    expect(s.lines).toEqual(['Breaker for anthropic reset.']);
  });

  it('rejects with exit code 1 listing the open breakers when the provider has none', async () => {
    const s = await setup();
    await new ProviderBreaker(s.breakerFile).open('openai', 'rate_limit', 60_000);
    const err = await cmdBreakerReset('anthropic', s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect(err).toMatchObject({ code: 1, message: 'No open breaker for anthropic. Open breakers: openai' });
  });

  it('says none when there is no breaker file', async () => {
    const s = await setup();
    await expect(cmdBreakerReset('anthropic', s.deps)).rejects.toThrow('Open breakers: none');
  });
});
