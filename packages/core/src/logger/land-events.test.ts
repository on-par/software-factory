import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from './index.js';
import { logEvent } from '../utils/index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

describe('land conflict event metadata', () => {
  it('persists paths and mechanical mode as top-level NDJSON fields', () => {
    const root = tempDirs.makeSync('factory-land-events-');
    const eventsFile = join(root, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });
    logger.info('conflict_resolved', 'resolved', { paths: ['docs/adr/README.md'], mode: 'mechanical' });
    const event = JSON.parse(readFileSync(eventsFile, 'utf8'));
    expect(event).toMatchObject({ paths: ['docs/adr/README.md'], mode: 'mechanical' });
  });

  it('forwards structured fields through logEvent', () => {
    const root = tempDirs.makeSync('factory-land-events-');
    const eventsFile = join(root, 'events.ndjson');
    logEvent(eventsFile, 'conflict_detected', 5, 'conflict', { paths: ['source.ts'] });
    logEvent(eventsFile, 'conflict_resolved', 5, 'resolved', {
      paths: ['docs/adr/README.md'],
      mode: 'mechanical',
    });
    const events = readFileSync(eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ paths: ['source.ts'] });
    expect(events[1]).toMatchObject({ paths: ['docs/adr/README.md'], mode: 'mechanical' });
  });
});
