// src/events/index.ts — Read and tail the .factory/events.ndjson append log

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import type { FactoryEvent } from '../types/index.js';
import { listEventSegments, liveSegmentId } from './tail.js';

function parseEventsFile(path: string): FactoryEvent[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FactoryEvent];
      } catch {
        return [];
      }
    });
}

export interface ReadEventsOptions {
  /** Also read rotated segments in <state>/logs/events/, oldest first (#1631). */
  includeSegments?: boolean;
}

/** Parse all events currently in the file. Missing file → []. Malformed lines are skipped. */
export function readEvents(eventsFile: string, opts: ReadEventsOptions = {}): FactoryEvent[] {
  if (!opts.includeSegments) return existsSync(eventsFile) ? parseEventsFile(eventsFile) : [];
  let events: FactoryEvent[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const segs = listEventSegments(eventsFile);
    events = [...segs.flatMap((seg) => parseEventsFile(seg.path)), ...parseEventsFile(eventsFile)];
    const after = listEventSegments(eventsFile);
    // A rotation ran mid-read when the segment list changed; retry for a consistent view.
    if (after.length === segs.length && after.every((seg, i) => seg.id === segs[i]!.id)) break;
  }
  return events;
}

export interface FollowEventsOptions {
  /** Replay events already in the file before tailing (default true — the TUI needs history to derive phase state). */
  fromStart?: boolean;
  /** Poll interval ms (default 250). Tests pass ~10. */
  pollMs?: number;
  /** Opens the events file for one poll (default fs.openSync read-only). Tests
   *  wrap it to rotate the file just before the open. */
  openFile?: (path: string) => number;
  /** Begin tailing at this byte offset; overrides fromStart. */
  startOffset?: number;
}

/** Tail the events file. Returns a stop() function. Never throws for a missing file — waits for it to appear. */
export function followEvents(
  eventsFile: string,
  onEvent: (e: FactoryEvent) => void,
  opts: FollowEventsOptions = {},
): () => void {
  const { fromStart = true, pollMs = 250, openFile = (path: string) => openSync(path, 'r'), startOffset } = opts;

  let offset = 0;
  let carry = '';
  let ino: number | undefined;
  let liveId = 0;

  const captureLiveId = (): void => {
    liveId = liveSegmentId(listEventSegments(eventsFile));
  };

  if (startOffset !== undefined) {
    offset = startOffset;
    try {
      ino = statSync(eventsFile).ino;
      captureLiveId();
    } catch {
      ino = undefined;
    }
  } else if (!fromStart) {
    try {
      const stat = statSync(eventsFile);
      offset = stat.size;
      ino = stat.ino;
      captureLiveId();
    } catch {
      offset = 0;
    }
  }

  const emitLines = (chunk: string): void => {
    const lines = chunk.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as FactoryEvent);
      } catch {
        // skip malformed line
      }
    }
  };

  /** Read [from, size) of an open fd and emit its complete lines; returns the new offset. */
  const readFrom = (fd: number, size: number, from: number): number => {
    if (size <= from) return from;
    const toRead = size - from;
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, from);
    emitLines(carry + buf.toString('utf-8', 0, bytesRead));
    return from + bytesRead;
  };

  const drainSegment = (path: string, from: number): void => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      readFrom(fd, fstatSync(fd).size, from);
    } finally {
      closeSync(fd);
    }
  };

  /** The file was replaced: emit the unread tail of the rotated old file (and any later segments). */
  const drainRotated = (): boolean => {
    const segs = listEventSegments(eventsFile);
    const old = segs.find((seg) => seg.id === liveId);
    if (!old) return false;
    drainSegment(old.path, offset);
    for (const seg of segs) {
      if (seg.id <= liveId) continue;
      carry = '';
      drainSegment(seg.path, 0);
    }
    return true;
  };

  const tick = (): void => {
    // Open first and take size/inode from the open fd, so the stat and the
    // read always describe the same file even if it is rotated in between.
    let fd: number;
    try {
      fd = openFile(eventsFile);
    } catch {
      // Missing file: treat it as empty so a recreated file is read from the start.
      offset = 0;
      carry = '';
      ino = undefined;
      return;
    }

    try {
      const stat = fstatSync(fd);

      // A changed inode means the file was deleted and recreated (e.g. log
      // rotation) — comparing size alone can miss this if the new file already
      // reached or exceeded the old offset before the next poll.
      const recreated = ino !== undefined && stat.ino !== ino;

      if (recreated) {
        drainRotated();
        offset = 0;
        carry = '';
      } else if (stat.size < offset) {
        offset = 0;
        carry = '';
      }
      if (recreated || ino === undefined) captureLiveId();
      ino = stat.ino;

      offset = readFrom(fd, stat.size, offset);
    } finally {
      closeSync(fd);
    }
  };

  const interval = setInterval(tick, pollMs);
  interval.unref?.();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };
}
