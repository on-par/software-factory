import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { logEvent } from './index.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

describe('logEvent — park payload (#3511)', () => {
  it('writes park onto the line only when passed', async () => {
    const eventsFile = join(await dirs.make('factory-events-'), 'events.ndjson');
    const park = { reason: 'escalate' as const, decision: 'decide', lane: 'app', blockedBehind: [8] };

    logEvent(eventsFile, 'parked', 5, 'parked', { park });
    logEvent(eventsFile, 'parked', 5, 'parked again');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0]).park).toEqual(park);
    expect(JSON.parse(lines[1])).not.toHaveProperty('park');
  });
});
