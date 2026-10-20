import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from './index.js';

const temps = createTempDirs();

afterEach(() => temps.cleanup());

it('includes escalateKind only when passed as extra (#3275)', async () => {
  const tmpDir = await temps.make('factory-logger-');
  const eventsFile = join(tmpDir, 'events.ndjson');
  const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });

  logger.info('escalate', 'ESCALATE: missing-info: which?', { escalateKind: 'missing-info' });
  logger.info('escalate', 'ESCALATE: which?');

  const events = (await readFile(eventsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(events[0].escalateKind).toBe('missing-info');
  expect(events[1]).not.toHaveProperty('escalateKind');
});
