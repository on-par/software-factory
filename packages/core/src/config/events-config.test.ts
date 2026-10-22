import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { loadFactoryConfigForRepo } from './index.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function load(events: unknown) {
  const path = join(tmp.makeSync('factory-events-config-'), 'config.json');
  writeFileSync(path, JSON.stringify({ events }));
  return loadFactoryConfigForRepo(path);
}

describe('events config section (#1631)', () => {
  it('accepts maxBytes and maxSegments', () => {
    expect(load({ maxBytes: 1048576, maxSegments: 3 }).events).toEqual({ maxBytes: 1048576, maxSegments: 3 });
  });

  it('rejects maxSegments 0', () => {
    expect(() => load({ maxSegments: 0 })).toThrow();
  });
});
