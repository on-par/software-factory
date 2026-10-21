import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { logEvent } from '../utils/index.js';
import { createLogger } from './index.js';

const temps = createTempDirs();

afterEach(() => temps.cleanup());

const attribution = { plan: { model: 'm', provider: 'p', effort: 'high' }, endedIn: 'plan' as const };

async function readLines(file: string) {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

it('createLogger writes attribution only when passed as extra (#3321)', async () => {
  const tmpDir = await temps.make('factory-logger-');
  const eventsFile = join(tmpDir, 'events.ndjson');
  const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });

  logger.info('escalate', 'with', { attribution });
  logger.info('escalate', 'without');

  const events = await readLines(eventsFile);
  expect(events[0].attribution).toEqual(attribution);
  expect(events[1]).not.toHaveProperty('attribution');
});

it('logEvent copies attribution onto the event line (#3321)', async () => {
  const tmpDir = await temps.make('factory-logger-');
  const eventsFile = join(tmpDir, 'events.ndjson');

  logEvent(eventsFile, 'fail', 5, 'parked', { attribution });

  expect((await readLines(eventsFile))[0].attribution).toEqual(attribution);
});
