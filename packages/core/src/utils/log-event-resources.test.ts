import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { logEvent } from './index.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

it('logEvent writes cpuMs and peakRssBytes onto the events.ndjson line', async () => {
  const eventsFile = join(await tempDirs.make('factory-events-'), 'events.ndjson');

  logEvent(eventsFile, 'phase_completed', 1, 'msg', { durationMs: 10, cpuMs: 7, peakRssBytes: 123_456 });

  const line = readFileSync(eventsFile, 'utf-8').split('\n').find(Boolean) ?? '';
  expect(JSON.parse(line)).toMatchObject({ durationMs: 10, cpuMs: 7, peakRssBytes: 123_456 });
});
