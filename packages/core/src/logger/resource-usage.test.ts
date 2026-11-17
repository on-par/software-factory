import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from './index.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

function readEvents(eventsFile: string): any[] {
  return readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('createLogger resource usage fields', () => {
  it('round-trips a phase_completed fixture with durationMs, cpuMs and peakRssBytes', async () => {
    const eventsFile = join(await tempDirs.make('factory-logger-'), 'events.ndjson');
    const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });

    logger.info('phase_completed', 'build done', { durationMs: 84_000, cpuMs: 3_000, peakRssBytes: 325_058_560 });

    const [event] = readEvents(eventsFile);
    expect(event).toMatchObject({
      type: 'phase_completed',
      durationMs: 84_000,
      cpuMs: 3_000,
      peakRssBytes: 325_058_560,
    });
  });

  it('omits cpuMs and peakRssBytes when not supplied', async () => {
    const eventsFile = join(await tempDirs.make('factory-logger-'), 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'no resources', { durationMs: 1 });

    const [event] = readEvents(eventsFile);
    expect(event).not.toHaveProperty('cpuMs');
    expect(event).not.toHaveProperty('peakRssBytes');
  });
});
