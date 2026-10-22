import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventLogRotation } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { eventSegmentFileName, eventSegmentsDir, listEventSegments } from '../events/tail.js';
import { createLogger } from './index.js';
import { pruneEventSegments, resolveLoggerRotation, rotateEventLogIfNeeded } from './rotate.js';

const tmp = createTempDirs();

describe('event log rotation', () => {
  let dir: string;
  let file: string;
  const out = { write: () => true };

  const logger = (rotation: Partial<EventLogRotation>) => createLogger(file, {}, { out, env: {}, rotation });
  const lineCount = (path: string) => readFileSync(path, 'utf-8').split('\n').filter(Boolean).length;

  beforeEach(() => {
    dir = tmp.makeSync('factory-rotate-');
    file = join(dir, 'state', 'events.ndjson');
  });

  afterEach(() => {
    void tmp.cleanup();
  });

  it('rotates events.ndjson into logs/events once appends pass maxBytes (1 MB)', () => {
    const log = logger({ maxBytes: 1024 * 1024 });
    const msg = 'x'.repeat(1000);
    const appends = 1100;
    for (let i = 0; i < appends; i++) log.info('plan', `${i} ${msg}`);

    const segDir = eventSegmentsDir(file);
    expect(readdirSync(segDir)).toEqual([eventSegmentFileName(0)]);
    const [seg] = listEventSegments(file);
    expect(seg!.size).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(file).size).toBeLessThan(1024 * 1024);
    expect(readFileSync(file, 'utf-8')).toContain(`${appends - 1} x`);
    expect(lineCount(seg!.path) + lineCount(file)).toBe(appends);
  });

  it('defaults maxBytes to 10 MB', () => {
    const rotation = resolveLoggerRotation(file, {});
    expect(rotation.maxBytes).toBe(10 * 1024 * 1024);
    expect(rotation.maxSegments).toBeUndefined();
  });

  it('keeps all 5 segments when maxSegments is unset, with chained ids', () => {
    const log = logger({ maxBytes: 200 });
    for (let i = 0; i < 12; i++) log.info('plan', `event ${i}`);

    const segs = listEventSegments(file);
    expect(segs.length).toBeGreaterThanOrEqual(5);
    expect(segs[0]!.id).toBe(0);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.id).toBe(segs[i - 1]!.id + segs[i - 1]!.size);
  });

  it('keeps only the newest 3 segments when maxSegments is 3', () => {
    const all = logger({ maxBytes: 200 });
    for (let i = 0; i < 12; i++) all.info('plan', `event ${i}`);
    const before = listEventSegments(file).map((s) => s.id);
    expect(before.length).toBeGreaterThan(3);

    rmSync(dir, { recursive: true, force: true });
    const log = logger({ maxBytes: 200, maxSegments: 3 });
    for (let i = 0; i < 12; i++) log.info('plan', `event ${i}`);
    const kept = listEventSegments(file).map((s) => s.id);
    expect(kept).toEqual(before.slice(-3));
  });

  it('still appends when rotation throws', () => {
    mkdirSync(join(dir, 'state', 'logs'), { recursive: true });
    writeFileSync(join(dir, 'state', 'logs', 'events'), 'not a dir');
    const log = logger({ maxBytes: 100 });
    log.info('plan', 'first event with some length to it');
    log.info('plan', 'second event with some length to it');
    expect(lineCount(file)).toBe(2);
  });

  it('does not rotate a missing, empty, or small file', () => {
    const rotation = { maxBytes: 10 };
    expect(rotateEventLogIfNeeded(file, 100, rotation)).toBeUndefined();
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(file, '');
    expect(rotateEventLogIfNeeded(file, 100, rotation)).toBeUndefined();
    writeFileSync(file, 'a\n');
    expect(rotateEventLogIfNeeded(file, 1, { maxBytes: 100 })).toBeUndefined();
  });

  it('pruneEventSegments never deletes the newest segment or non-segment files', () => {
    const segDir = eventSegmentsDir(file);
    mkdirSync(segDir, { recursive: true });
    writeFileSync(join(segDir, eventSegmentFileName(0)), 'aa\n');
    writeFileSync(join(segDir, eventSegmentFileName(3)), 'bb\n');
    writeFileSync(join(segDir, 'notes.txt'), 'keep');
    const deleted = pruneEventSegments(file, 0);
    expect(deleted).toEqual([join(segDir, eventSegmentFileName(0))]);
    expect(readdirSync(segDir).sort()).toEqual([eventSegmentFileName(3), 'notes.txt']);
  });
});
