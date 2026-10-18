import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { formatStopMarker, readStopMarker } from '../utils/stop-marker.js';
import { watchUsage } from './index.js';

describe('watchUsage default setStop (#3209)', () => {
  const temp = createTempDirs();
  afterEach(() => temp.cleanup());

  function runWith(stopFile: string) {
    return watchUsage({
      cap: 1,
      stopAt: 0.75,
      pollMs: 1,
      stopFile,
      eventsFile: join(dirname(stopFile), 'events.ndjson'),
      readUsageFn: async () => ({ pct: 0.9, source: 'estimate', detail: 'd' }),
      emitEvent: () => {},
      sleep: async () => {},
    });
  }

  it('writes a usage-watchdog marker on a fresh stop', async () => {
    const dir = temp.makeSync('wd-stop-');
    try {
      const file = join(dir, 'STOP');
      await expect(runWith(file)).resolves.toBe('stopped');
      expect(readStopMarker(file)?.source).toBe('usage-watchdog');
    } finally {
      await temp.cleanup();
    }
  });

  it('does not overwrite an existing manual STOP', async () => {
    const dir = temp.makeSync('wd-stop-');
    try {
      const file = join(dir, 'STOP');
      writeFileSync(file, formatStopMarker('manual'));
      await expect(runWith(file)).resolves.toBe('stopped');
      expect(readStopMarker(file)?.source).toBe('manual');
    } finally {
      await temp.cleanup();
    }
  });
});
