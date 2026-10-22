import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EVENTS_MAX_BYTES, resetEventLogRotationCache, resolveEventLogRotation } from '../events/rotation.js';
import { readEvents } from '../events/index.js';
import { eventSegmentFileName, eventSegmentsDir } from '../events/tail.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from './index.js';

const tmp = createTempDirs();
const sink = { write: () => true };
const PAD = 'x'.repeat(1000);

describe('event log rotation (#1631)', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    resetEventLogRotationCache();
    root = tmp.makeSync('factory-rotation-');
    file = join(root, 'state', 'events.ndjson');
  });
  afterEach(async () => {
    resetEventLogRotationCache();
    await tmp.cleanup();
  });

  const segments = () => readdirSync(eventSegmentsDir(file)).sort();

  it('rotates the live file into state/logs/events/ once it passes maxBytes, and new events go to a fresh events.ndjson', () => {
    const log = createLogger(file, {}, { out: sink, env: {}, rotation: { maxBytes: 1024 * 1024 } });
    for (let i = 0; i < 1100; i++) log.info('plan', `m${i} ${PAD}`);
    for (let i = 1100; i < 1105; i++) log.info('plan', `m${i}`);

    expect(segments()).toEqual([eventSegmentFileName(0)]);
    expect(statSync(join(eventSegmentsDir(file), eventSegmentFileName(0))).size).toBeGreaterThan(1024 * 1024);
    expect(statSync(file).size).toBeLessThan(200 * 1024);
    const all = readEvents(file, { includeSegments: true });
    expect(all.map((e) => e.msg.split(' ')[0])).toEqual(Array.from({ length: 1105 }, (_, i) => `m${i}`));
    expect(readEvents(file).length).toBeLessThan(200);
  });

  it('defaults maxBytes to 10 MiB when nothing is configured', () => {
    expect(resolveEventLogRotation(file, {})).toEqual({ maxBytes: 10 * 1024 * 1024 });
    expect(DEFAULT_EVENTS_MAX_BYTES).toBe(10485760);
    const log = createLogger(file, {}, { out: sink, env: {} });
    for (let i = 0; i < 1100; i++) log.info('plan', `m${i} ${PAD}`);
    expect(existsSync(eventSegmentsDir(file))).toBe(false);
  });

  it('keeps all 5 segments when maxSegments is unset, and only the newest 3 with maxSegments 3', () => {
    const run = (f: string, maxSegments?: number) => {
      const log = createLogger(f, {}, { out: sink, env: {}, rotation: { maxBytes: 512, maxSegments } });
      for (let i = 0; i < 5; i++) log.info('plan', `big${i} ${'y'.repeat(600)}`);
    };
    run(file);
    const names = segments();
    expect(names).toHaveLength(5);
    let expectedId = 0;
    for (const name of names) {
      expect(name).toBe(eventSegmentFileName(expectedId));
      expectedId += statSync(join(eventSegmentsDir(file), name)).size;
    }

    const other = join(root, 'other', 'events.ndjson');
    run(other, 3);
    expect(readdirSync(eventSegmentsDir(other)).sort()).toEqual(names.slice(2));
  });

  it('honours FACTORY_EVENTS_MAX_BYTES and ignores invalid values', () => {
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: '2048' }).maxBytes).toBe(2048);
    for (const bad of ['0', 'abc', '', '-5', '1.5']) {
      expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: bad }).maxBytes).toBe(DEFAULT_EVENTS_MAX_BYTES);
    }
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_SEGMENTS: '0' }).maxSegments).toBeUndefined();
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_SEGMENTS: '4' }).maxSegments).toBe(4);
  });

  it('reads events.maxBytes/maxSegments from the repo config, below env', () => {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ events: { maxBytes: 4096, maxSegments: 2 } }));
    expect(resolveEventLogRotation(file, {})).toEqual({ maxBytes: 4096, maxSegments: 2 });
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: '99' }).maxBytes).toBe(99);
  });
});
