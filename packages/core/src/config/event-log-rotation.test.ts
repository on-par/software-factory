import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { DEFAULT_EVENT_LOG_MAX_BYTES, loadFactoryConfig, resolveEventLogRotation } from './index.js';

const tmp = createTempDirs();

describe('resolveEventLogRotation', () => {
  afterEach(() => tmp.cleanup());

  it('defaults to 10 MB and keep-all', () => {
    expect(resolveEventLogRotation(undefined, {})).toEqual({ maxBytes: DEFAULT_EVENT_LOG_MAX_BYTES });
    expect(DEFAULT_EVENT_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('uses config values', () => {
    expect(resolveEventLogRotation({ events: { maxBytes: 5, maxSegments: 2 } }, {})).toEqual({
      maxBytes: 5,
      maxSegments: 2,
    });
  });

  it('env overrides config', () => {
    const env = { FACTORY_EVENTS_MAX_BYTES: '7', FACTORY_EVENTS_MAX_SEGMENTS: '4' };
    expect(resolveEventLogRotation({ events: { maxBytes: 5, maxSegments: 2 } }, env)).toEqual({
      maxBytes: 7,
      maxSegments: 4,
    });
  });

  it.each(['', 'abc', '0', '-3', '1.5'])('ignores invalid env value %j', (bad) => {
    const env = { FACTORY_EVENTS_MAX_BYTES: bad, FACTORY_EVENTS_MAX_SEGMENTS: bad };
    expect(resolveEventLogRotation({ events: { maxBytes: 5 } }, env)).toEqual({ maxBytes: 5 });
  });

  it('invalid config values fall back and the config still loads', () => {
    const dir = tmp.makeSync('factory-events-cfg-');
    {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ ...loadFactoryConfig(), events: { maxBytes: -1, maxSegments: 3 } }));
      const config = loadFactoryConfig(path);
      expect(config.events).toEqual({ maxSegments: 3 });
      expect(resolveEventLogRotation(config, {})).toEqual({ maxBytes: DEFAULT_EVENT_LOG_MAX_BYTES, maxSegments: 3 });
    }
  });
});
