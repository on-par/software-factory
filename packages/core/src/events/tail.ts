// src/events/tail.ts — Bounded reads of the events log: newest-N backwards, and "after cursor" forwards.
//
// Segment naming (#3174; #1631 rotation must follow it):
//   - Rotated segments live in `<state>/logs/events/` as `events-<id zero-padded to 16 digits>.ndjson`.
//   - A segment id is the segment's start offset in the global byte stream of every event line ever written.
//   - The live file's id is (newest rotated id + its size), or 0 when no rotated segment exists.
//     Renaming the live file to eventSegmentFileName(liveId) and appending to a fresh live file therefore
//     keeps every old cursor valid.
//   - Retention (#1631) must not delete the newest rotated segment, or the live id chain breaks.
//   - Rotation is implemented by rotateEventLog (the logger calls it under the event-log lock).

import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { FactoryEvent } from '../types/index.js';

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const SEGMENT_NAME = /^events-(\d{16})\.ndjson$/;
const CURSOR_PREFIX = 'c1.';

export interface EventWithCursor {
  event: FactoryEvent;
  cursor: string;
}

export interface EventPage {
  events: EventWithCursor[];
  /** Live-file byte offset the read reached (live size up to its last newline); start point for --follow. */
  endOffset: number;
}

export interface EventReadOptions {
  match?: (e: FactoryEvent) => boolean;
  limit?: number;
  onBytesRead?: (n: number) => void;
}

export class InvalidEventCursorError extends Error {
  override name = 'InvalidEventCursorError';
  constructor(
    readonly code: 'malformed-cursor' | 'unknown-cursor',
    message: string,
  ) {
    super(message);
  }
}

export function eventSegmentsDir(eventsFile: string): string {
  return join(dirname(eventsFile), 'logs', 'events');
}

export function eventSegmentFileName(segmentId: number): string {
  return `events-${String(segmentId).padStart(16, '0')}.ndjson`;
}

interface Segment {
  id: number;
  size: number;
  path: string;
}

function listSegments(dir: string): Segment[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const segments: Segment[] = [];
  for (const name of names) {
    const m = SEGMENT_NAME.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      segments.push({ id: Number(m[1]), size: statSync(path).size, path });
    } catch {
      // vanished between readdir and stat
    }
  }
  return segments.sort((a, b) => a.id - b.id);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function encodeCursor(segmentId: number, offset: number): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ v: 1, s: segmentId, o: offset })).toString('base64url');
}

function decodeCursor(cursor: string): { segmentId: number; offset: number } {
  const bad = (why: string): InvalidEventCursorError =>
    new InvalidEventCursorError('malformed-cursor', `Malformed cursor: ${why}`);
  if (!cursor.startsWith(CURSOR_PREFIX)) throw bad('missing prefix');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf-8'));
  } catch {
    throw bad('not valid base64url JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad('unexpected shape');
  const { v, s, o } = parsed as Record<string, unknown>;
  if (v !== 1) throw bad('unsupported version');
  if (!Number.isSafeInteger(s) || (s as number) < 0) throw bad('invalid segment id');
  if (!Number.isSafeInteger(o) || (o as number) < 0) throw bad('invalid offset');
  return { segmentId: s as number, offset: o as number };
}

/** Read bytes [start, end) of a file; every content read goes through here. */
function readRange(path: string, start: number, end: number, onBytesRead?: (n: number) => void): Buffer {
  const buf = Buffer.alloc(Math.max(0, end - start));
  if (buf.length === 0) return buf;
  const fd = openSync(path, 'r');
  let got = 0;
  try {
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  onBytesRead?.(got);
  return got === buf.length ? buf : buf.subarray(0, got);
}

/** Offset just after the last newline within the first `size` bytes (0 when there is none). */
function trimmedEnd(path: string, size: number, onBytesRead?: (n: number) => void): number {
  let pos = size;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK_BYTES);
    const idx = readRange(path, start, pos, onBytesRead).lastIndexOf(NEWLINE);
    if (idx !== -1) return start + idx + 1;
    pos = start;
  }
  return 0;
}

function parseLine(line: Buffer): FactoryEvent | undefined {
  const text = line.toString('utf-8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as FactoryEvent;
  } catch {
    return undefined;
  }
}

function assertLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
}

/** Collect up to `need` matches from one segment walking backwards; appends newest-first to `found`. */
function scanBackward(seg: Segment, end: number, need: number, opts: EventReadOptions, found: EventWithCursor[]): void {
  const match = opts.match ?? (() => true);
  let carry: Buffer = Buffer.alloc(0);
  let pos = end;
  while (pos > 0 && found.length < need) {
    const start = Math.max(0, pos - CHUNK_BYTES);
    const data = Buffer.concat([readRange(seg.path, start, pos, opts.onBytesRead), carry]);
    let e = data.length;
    while (e > 0 && found.length < need) {
      const p = e >= 2 ? data.lastIndexOf(NEWLINE, e - 2) : -1;
      if (p === -1 && start > 0) break;
      const event = parseLine(data.subarray(p + 1, e - 1));
      if (event && match(event)) found.push({ event, cursor: encodeCursor(seg.id, start + e) });
      e = p + 1;
    }
    carry = data.subarray(0, e);
    pos = start;
  }
}

function liveSegment(eventsFile: string, rotated: Segment[]): Segment {
  const last = rotated[rotated.length - 1];
  return { id: last ? last.id + last.size : 0, size: fileSize(eventsFile), path: eventsFile };
}

/** Rotated segment paths, oldest first. */
export function listEventSegmentPaths(eventsFile: string): string[] {
  return listSegments(eventSegmentsDir(eventsFile)).map((s) => s.path);
}

/** Move the live file into logs/events/ as the next segment (#1631). Caller holds the event-log lock.
 *  Returns the segment path, or undefined when nothing was rotated. The next append creates the live file.
 *  With maxSegments set, the oldest segments beyond it are removed; the newest is always kept. */
export function rotateEventLog(eventsFile: string, opts: { maxSegments?: number } = {}): string | undefined {
  const dir = eventSegmentsDir(eventsFile);
  const live = liveSegment(eventsFile, listSegments(dir));
  if (live.size === 0) return undefined;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, eventSegmentFileName(live.id));
  try {
    // A hard link keeps the inode (like a rename) but fails with EEXIST instead of clobbering a segment.
    linkSync(eventsFile, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
  try {
    unlinkSync(eventsFile);
  } catch {
    rmSync(target, { force: true });
    return undefined;
  }
  const keep = opts.maxSegments;
  if (keep !== undefined && Number.isInteger(keep) && keep >= 1) {
    const segments = listSegments(dir);
    for (const seg of segments.slice(0, Math.max(0, segments.length - keep))) {
      try {
        rmSync(seg.path, { force: true });
      } catch {
        // best effort retention
      }
    }
  }
  return target;
}

/** The rotated segment whose inode is `ino` (link/rename keep it), plus the segments newer than it. */
export function findEventSegmentByIno(eventsFile: string, ino: number): { path: string; newer: string[] } | undefined {
  const segments = listSegments(eventSegmentsDir(eventsFile));
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    let segIno: number;
    try {
      const fd = openSync(seg.path, 'r');
      try {
        segIno = fstatSync(fd).ino;
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (segIno === ino) return { path: seg.path, newer: segments.slice(i + 1).map((s) => s.path) };
  }
  return undefined;
}

/** The newest `limit` matching events (oldest first), found by reading the log backwards in chunks. */
export function readEventsTail(eventsFile: string, opts: EventReadOptions & { limit: number }): EventPage {
  assertLimit(opts.limit);
  const rotated = listSegments(eventSegmentsDir(eventsFile));
  const live = liveSegment(eventsFile, rotated);
  const liveEnd = trimmedEnd(live.path, live.size, opts.onBytesRead);

  const found: EventWithCursor[] = [];
  scanBackward(live, liveEnd, opts.limit, opts, found);
  for (let i = rotated.length - 1; i >= 0 && found.length < opts.limit; i--) {
    const seg = rotated[i]!;
    scanBackward(seg, trimmedEnd(seg.path, seg.size, opts.onBytesRead), opts.limit, opts, found);
  }
  return { events: found.reverse(), endOffset: liveEnd };
}

/**
 * Scan [from, size) of a segment forwards in chunks, appending matches to `out` until `limit` is reached.
 * Returns the offset reached (just after the last consumed line).
 */
function scanForward(seg: Segment, from: number, opts: EventReadOptions, out: EventWithCursor[]): number {
  const match = opts.match ?? (() => true);
  const limit = opts.limit ?? Infinity;
  let reached = from;
  let carry: Buffer = Buffer.alloc(0);
  let pos = from;
  while (pos < seg.size && out.length < limit) {
    const next = Math.min(seg.size, pos + CHUNK_BYTES);
    const data = Buffer.concat([carry, readRange(seg.path, pos, next, opts.onBytesRead)]);
    const base = pos - carry.length;
    let lineStart = 0;
    let nl = data.indexOf(NEWLINE, lineStart);
    while (nl !== -1 && out.length < limit) {
      const event = parseLine(data.subarray(lineStart, nl));
      reached = base + nl + 1;
      if (event && match(event)) out.push({ event, cursor: encodeCursor(seg.id, reached) });
      lineStart = nl + 1;
      nl = data.indexOf(NEWLINE, lineStart);
    }
    carry = data.subarray(lineStart);
    pos = next;
  }
  return reached;
}

/** Events after `cursor` (oldest first), across later rotated segments and the live file. */
export function readEventsSince(eventsFile: string, cursor: string, opts: EventReadOptions = {}): EventPage {
  assertLimit(opts.limit);
  const { segmentId, offset } = decodeCursor(cursor);
  const rotated = listSegments(eventSegmentsDir(eventsFile));
  const live = liveSegment(eventsFile, rotated);

  const start = rotated.find((s) => s.id === segmentId) ?? (segmentId === live.id ? live : undefined);
  if (!start) throw new InvalidEventCursorError('unknown-cursor', 'Unknown cursor: no such log segment');
  if (offset > start.size)
    throw new InvalidEventCursorError('unknown-cursor', 'Unknown cursor: offset is past the end of its segment');
  if (offset > 0 && readRange(start.path, offset - 1, offset, opts.onBytesRead)[0] !== NEWLINE) {
    throw new InvalidEventCursorError('unknown-cursor', 'Unknown cursor: offset is not on an event boundary');
  }

  const out: EventWithCursor[] = [];
  const limit = opts.limit ?? Infinity;
  const queue: Array<{ seg: Segment; from: number }> = [{ seg: start, from: offset }];
  if (start !== live) {
    for (const seg of rotated) if (seg.id > start.id) queue.push({ seg, from: 0 });
    queue.push({ seg: live, from: 0 });
  }

  let endOffset: number | undefined;
  for (const { seg, from } of queue) {
    if (out.length >= limit) break;
    const reached = scanForward(seg, from, opts, out);
    if (seg === live) endOffset = reached;
  }
  return { events: out, endOffset: endOffset ?? trimmedEnd(live.path, live.size, opts.onBytesRead) };
}
