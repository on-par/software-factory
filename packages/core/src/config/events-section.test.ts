import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { resetEventLogRotationCache, resolveEventLogRotation } from '../events/rotation.js';
import { loadFactoryConfigForRepo } from './index.js';

const tmp = createTempDirs();

describe('events config section (#1631)', () => {
  afterEach(async () => {
    resetEventLogRotationCache();
    await tmp.cleanup();
  });

  const load = (events: unknown) => {
    const root = tmp.makeSync('factory-events-cfg-');
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 2, events }));
    return { root, config: loadFactoryConfigForRepo(path) };
  };

  it('loads maxBytes and maxSegments', () => {
    expect(load({ maxBytes: 1048576, maxSegments: 3 }).config.events).toEqual({ maxBytes: 1048576, maxSegments: 3 });
  });

  it('loads invalid values as unset instead of failing (ADR-0160)', () => {
    const { root, config } = load({ maxSegments: 0, maxBytes: 'big' });
    expect(config.events).toEqual({});
    expect(resolveEventLogRotation(join(root, 'state', 'events.ndjson'), {})).toEqual({ maxBytes: 10485760 });
  });
});
