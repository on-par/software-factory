import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { logEvent } from './index.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

describe('logEvent — providerCapped payload (#3337)', () => {
  it('writes providerCapped onto the line only when passed', async () => {
    const eventsFile = join(await dirs.make('factory-events-'), 'events.ndjson');
    const providerCapped = {
      provider: 'claude',
      stage: 'plan' as const,
      issue: 5,
      cappedUntil: '2026-10-21T12:02:00.000Z',
      source: 'reported' as const,
      detail: 'limit',
    };

    logEvent(eventsFile, 'provider_capped', 5, 'capped', { providerCapped });
    logEvent(eventsFile, 'provider_capped', 5, 'again');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0]).providerCapped).toEqual(providerCapped);
    expect(JSON.parse(lines[1])).not.toHaveProperty('providerCapped');
  });
});
