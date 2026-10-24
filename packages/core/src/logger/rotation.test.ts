import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEvents } from '../events/index.js';
import { resetEventLogRotationCache, resolveEventLogRotation } from '../events/rotation.js';
import { eventSegmentFileName, eventSegmentsDir } from '../events/tail.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger, type LoggerOptions } from './index.js';

const tmp = createTempDirs();
const out = { write: () => true };

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

  const logger = (opts: LoggerOptions = {}) => createLogger(file, { repo: 'o/r' }, { out, env: {}, ...opts });

  it('rotates the live file into state/logs/events/ once it passes maxBytes, and new events go to a fresh events.ndjson', () => {
    const log = logger({ rotation: { maxBytes: 1024 * 1024 } });
    const pad = 'x'.repeat(1000);
    for (let i = 0; i < 1100; i++) log.info('plan', `m${i}${pad}`);
    for (let i = 1100; i < 1105; i++) log.info('plan', `m${i}`);

    const names = readdirSync(eventSegmentsDir(file));
    expect(names).toEqual([eventSegmentFileName(0)]);
    expect(readFileSync(join(eventSegmentsDir(file), names[0]!)).length).toBeGreaterThan(1024 * 1024);
    expect(readFileSync(file).length).toBeLessThan(200 * 1024);
    const msgs = readEvents(file, { includeSegments: true }).map((e) => e.msg.replace(/x+$/, ''));
    expect(msgs).toEqual(Array.from({ length: 1105 }, (_, i) => `m${i}`));
    expect(readEvents(file).length).toBeLessThan(200);
  });

  it('defaults maxBytes to 10 MiB when nothing is configured', () => {
    expect(resolveEventLogRotation(file, {})).toEqual({ maxBytes: 10485760 });
    const log = logger();
    const pad = 'x'.repeat(1000);
    for (let i = 0; i < 1100; i++) log.info('plan', `m${i}${pad}`);
    expect(readdirSync(join(root, 'state'))).not.toContain('logs');
  });

  it('keeps all 5 segments when maxSegments is unset, and only the newest 3 with maxSegments 3', () => {
    const run = (target: string, rotation: LoggerOptions['rotation']) => {
      const log = createLogger(target, { repo: 'o/r' }, { out, env: {}, rotation });
      for (let i = 0; i < 6; i++) log.info('plan', `e${i}${'y'.repeat(600)}`);
      return readdirSync(eventSegmentsDir(target));
    };
    const all = run(file, { maxBytes: 512 });
    expect(all).toHaveLength(6);
    let id = 0;
    for (const name of all) {
      expect(name).toBe(eventSegmentFileName(id));
      id += readFileSync(join(eventSegmentsDir(file), name)).length;
    }
    const other = join(tmp.makeSync('factory-rotation-b-'), 'state', 'events.ndjson');
    expect(run(other, { maxBytes: 512, maxSegments: 3 })).toEqual(all.slice(-3));
  });

  it('resolves policy as override > env > repo config > default, ignoring invalid values', () => {
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: '2048' })).toEqual({ maxBytes: 2048 });
    for (const bad of ['0', 'abc', '', '-5', '1.5']) {
      expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: bad })).toEqual({ maxBytes: 10485760 });
    }
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_SEGMENTS: '0' }).maxSegments).toBeUndefined();
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_SEGMENTS: '4' }).maxSegments).toBe(4);

    writeFileSync(join(root, 'config.json'), JSON.stringify({ events: { maxBytes: 4096, maxSegments: 2 } }));
    resetEventLogRotationCache();
    expect(resolveEventLogRotation(file, {})).toEqual({ maxBytes: 4096, maxSegments: 2 });
    expect(resolveEventLogRotation(file, { FACTORY_EVENTS_MAX_BYTES: '2048' })).toEqual({
      maxBytes: 2048,
      maxSegments: 2,
    });
    expect(resolveEventLogRotation(file, {}, { maxBytes: 99 }).maxBytes).toBe(99);
  });

  it('a rotation failure never throws and never loses the event', () => {
    mkdirSync(eventSegmentsDir(file), { recursive: true });
    writeFileSync(join(eventSegmentsDir(file), eventSegmentFileName(0)), '');
    const log = logger({ rotation: { maxBytes: 10 } });
    expect(() => log.info('plan', 'survivor')).not.toThrow();
    expect(readEvents(file).map((e) => e.msg)).toEqual(['survivor']);
  });
});
