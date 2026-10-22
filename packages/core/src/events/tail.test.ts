import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidEventCursorError,
  eventSegmentFileName,
  eventSegmentsDir,
  findEventSegmentByIno,
  listEventSegmentPaths,
  readEventsSince,
  readEventsTail,
  rotateEventLog,
} from './tail.js';
import { createTempDirs } from '../harness/temp-dir.js';

const tmp = createTempDirs();

const ev = (i: number, pad = '') =>
  JSON.stringify({ ts: 't', type: 'plan', issue: String(i % 2), msg: `e${i}${pad}` }) + '\n';
const msgs = (p: { events: Array<{ event: { msg: string } }> }) => p.events.map((x) => x.event.msg);
const cursorB64 = (o: unknown) => 'c1.' + Buffer.from(JSON.stringify(o)).toString('base64url');

describe('events tail', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tmp.makeSync('factory-tail-');
    file = join(dir, 'events.ndjson');
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('names segments by zero-padded start offset', () => {
    expect(eventSegmentFileName(0)).toBe('events-0000000000000000.ndjson');
    expect(eventSegmentsDir(file)).toBe(join(dir, 'logs', 'events'));
  });

  it('round-trips cursors from tail into since', () => {
    writeFileSync(file, [0, 1, 2, 3].map((i) => ev(i)).join(''));
    const page = readEventsTail(file, { limit: 3 });
    expect(msgs(page)).toEqual(['e1', 'e2', 'e3']);
    expect(msgs(readEventsSince(file, page.events[0]!.cursor))).toEqual(['e2', 'e3']);
  });

  it.each([
    ['empty', ''],
    ['garbage', 'garbage'],
    ['bad base64', 'c1.!!!'],
    ['wrong version', cursorB64({ v: 2, s: 0, o: 0 })],
    ['negative offset', cursorB64({ v: 1, s: 0, o: -1 })],
    ['non-object', cursorB64(5)],
  ])('rejects %s as malformed-cursor', (_n, cursor) => {
    writeFileSync(file, ev(0));
    expect(() => readEventsSince(file, cursor)).toThrow(InvalidEventCursorError);
    try {
      readEventsSince(file, cursor);
    } catch (e) {
      expect((e as InvalidEventCursorError).code).toBe('malformed-cursor');
    }
  });

  it('rejects unknown segment, offset past size, and offset off a line boundary', () => {
    writeFileSync(file, ev(0));
    for (const c of [
      cursorB64({ v: 1, s: 999, o: 0 }),
      cursorB64({ v: 1, s: 0, o: 9999 }),
      cursorB64({ v: 1, s: 0, o: 3 }),
    ]) {
      expect(() => readEventsSince(file, c)).toThrow(/Unknown cursor/);
    }
  });

  it('tails across chunk boundaries with lines longer than 64 KiB', () => {
    const big = 'x'.repeat(70_000);
    writeFileSync(file, [0, 1, 2, 3, 4].map((i) => ev(i, i % 2 ? big : '')).join(''));
    expect(msgs(readEventsTail(file, { limit: 3 })).map((m) => m.slice(0, 2))).toEqual(['e2', 'e3', 'e4']);
    expect(readEventsTail(file, { limit: 50 }).events).toHaveLength(5);
  });

  it('ignores a trailing partial line and skips malformed lines', () => {
    writeFileSync(file, ev(0) + 'not json\n\n' + ev(1) + '{"ts":"t","ty');
    const page = readEventsTail(file, { limit: 5 });
    expect(msgs(page)).toEqual(['e0', 'e1']);
    appendFileSync(file, 'pe":"plan","msg":"e2"}\n');
    expect(msgs(readEventsSince(file, page.events[1]!.cursor))).toEqual(['e2']);
  });

  it('applies match and continues into rotated segments; limit above total returns all', () => {
    const seg = eventsRotated(file, [0, 1, 2, 3]);
    writeFileSync(file, [4, 5].map((i) => ev(i)).join(''));
    expect(seg).toBeGreaterThan(0);
    const odd = readEventsTail(file, { limit: 3, match: (e) => e.issue === '1' });
    expect(msgs(odd)).toEqual(['e1', 'e3', 'e5']);
    expect(readEventsTail(file, { limit: 100 }).events).toHaveLength(6);
  });

  it('handles a missing live file', () => {
    expect(readEventsTail(file, { limit: 3 })).toEqual({ events: [], endOffset: 0 });
    expect(readEventsSince(file, cursorB64({ v: 1, s: 0, o: 0 }))).toEqual({ events: [], endOffset: 0 });
  });

  it('pages forward with limit', () => {
    writeFileSync(file, [0, 1, 2, 3, 4].map((i) => ev(i)).join(''));
    const first = readEventsTail(file, { limit: 5 });
    const p1 = readEventsSince(file, first.events[0]!.cursor, { limit: 2 });
    expect(msgs(p1)).toEqual(['e1', 'e2']);
    expect(msgs(readEventsSince(file, p1.events[1]!.cursor, { limit: 2 }))).toEqual(['e3', 'e4']);
  });

  it('reads a legacy line without attribution and round-trips one with it through the tail', () => {
    const attribution = { build: { model: 'm', provider: 'p' }, endedIn: 'build' };
    writeFileSync(
      file,
      JSON.stringify({ ts: 't', type: 'fail', issue: '1', msg: 'old' }) +
        '\n' +
        JSON.stringify({ ts: 't', type: 'fail', issue: '1', msg: 'new', attribution }) +
        '\n',
    );
    const [legacy, stamped] = readEventsTail(file, { limit: 2 }).events;
    expect(legacy!.event.attribution).toBeUndefined();
    expect(stamped!.event.attribution).toEqual(attribution);
  });

  it('rejects an invalid limit', () => {
    expect(() => readEventsTail(file, { limit: 0 })).toThrow(RangeError);
  });
});

/** Write `ids` as rotated segment 0; returns its size. */
function eventsRotated(file: string, ids: number[]): number {
  mkdirSync(eventSegmentsDir(file), { recursive: true });
  const body = ids.map((i) => ev(i)).join('');
  writeFileSync(join(eventSegmentsDir(file), eventSegmentFileName(0)), body);
  return body.length;
}

describe('rotateEventLog (#1631)', () => {
  let file: string;
  beforeEach(() => {
    file = join(tmp.makeSync('factory-rotate-'), 'state', 'events.ndjson');
    mkdirSync(join(file, '..'), { recursive: true });
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('names segments by the id chain and leaves no live file', () => {
    writeFileSync(file, ev(1) + ev(2));
    const first = rotateEventLog(file);
    expect(first).toBe(join(eventSegmentsDir(file), eventSegmentFileName(0)));
    expect(existsSync(file)).toBe(false);
    const size1 = ev(1).length + ev(2).length;
    writeFileSync(file, ev(3));
    expect(rotateEventLog(file)).toBe(join(eventSegmentsDir(file), eventSegmentFileName(size1)));
    expect(listEventSegmentPaths(file)).toHaveLength(2);
  });

  it('returns undefined for an empty or missing live file, and refuses to overwrite a segment', () => {
    expect(rotateEventLog(file)).toBeUndefined();
    writeFileSync(file, ev(1));
    mkdirSync(eventSegmentsDir(file), { recursive: true });
    const clash = join(eventSegmentsDir(file), eventSegmentFileName(0));
    // an id-0 segment of size 0 makes the live id 0 again
    writeFileSync(clash, '');
    expect(rotateEventLog(file)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it('never deletes the newest segment, even with maxSegments 1', () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(file, ev(i));
      rotateEventLog(file, { maxSegments: 1 });
    }
    const left = listEventSegmentPaths(file);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(eventSegmentFileName(ev(0).length + ev(1).length));
  });

  it('keeps pre-rotation cursors valid for readEventsSince', () => {
    writeFileSync(file, ev(1) + ev(2));
    const cursor = readEventsTail(file, { limit: 1 }).events[0]!.cursor;
    writeFileSync(file, ev(1) + ev(2) + ev(3));
    rotateEventLog(file);
    appendFileSync(file, ev(4));
    expect(msgs(readEventsSince(file, cursor))).toEqual(['e3', 'e4']);
  });

  it('findEventSegmentByIno locates a renamed file and its newer segments', () => {
    writeFileSync(file, ev(1));
    const ino = statSync(file).ino;
    rotateEventLog(file);
    writeFileSync(file, ev(2));
    rotateEventLog(file);
    const found = findEventSegmentByIno(file, ino)!;
    expect(found.path).toContain(eventSegmentFileName(0));
    expect(found.newer).toHaveLength(1);
    expect(findEventSegmentByIno(file, -1)).toBeUndefined();
  });
});
