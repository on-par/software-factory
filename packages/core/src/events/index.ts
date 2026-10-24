// src/events/index.ts — Read and tail the .factory/events.ndjson append log

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import type { FactoryEvent } from '../types/index.js';
import { findEventSegmentByIno, listEventSegmentPaths } from './tail.js';

function parseFile(path: string): FactoryEvent[] {
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

/** Parse all events currently in the file. Missing file → []. Malformed lines are skipped.
 *  With `includeSegments`, rotated segments (#1631) come first, oldest to newest, then the live file —
 *  the full history, for readers such as KPIs. */
export function readEvents(eventsFile: string, opts: { includeSegments?: boolean } = {}): FactoryEvent[] {
  if (!opts.includeSegments) return parseFile(eventsFile);
  return [...listEventSegmentPaths(eventsFile).flatMap(parseFile), ...parseFile(eventsFile)];
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

  if (startOffset !== undefined) {
    offset = startOffset;
    try {
      ino = statSync(eventsFile).ino;
    } catch {
      ino = undefined;
    }
  } else if (!fromStart) {
    try {
      const stat = statSync(eventsFile);
      offset = stat.size;
      ino = stat.ino;
    } catch {
      offset = 0;
    }
  }

  /** Read [from, size) of an open fd, emit its complete lines, return the new offset and partial-line carry. */
  const drain = (fd: number, from: number, size: number, prevCarry: string): { offset: number; carry: string } => {
    if (size <= from) return { offset: from, carry: prevCarry };
    const toRead = size - from;
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, from);
    const lines = (prevCarry + buf.toString('utf-8', 0, bytesRead)).split('\n');
    const carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as FactoryEvent);
      } catch {
        // skip malformed line
      }
    }
    return { offset: from + bytesRead, carry };
  };

  const drainPath = (path: string, from: number, prevCarry: string): void => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      drain(fd, from, fstatSync(fd).size, prevCarry);
    } finally {
      closeSync(fd);
    }
  };

  /** Rotation moved the old inode into a segment: finish it, then any newer segments, before the new file. */
  const drainRotated = (oldIno: number, from: number, prevCarry: string): void => {
    const found = findEventSegmentByIno(eventsFile, oldIno);
    if (!found) return;
    drainPath(found.path, from, prevCarry);
    for (const path of found.newer) drainPath(path, 0, '');
  };

  const tick = (): void => {
    // Open first and take size/inode from the open fd, so the stat and the
    // read always describe the same file even if it is rotated in between.
    let fd: number;
    try {
      fd = openFile(eventsFile);
    } catch {
      // Missing file: treat it as empty so a recreated file is read from the start.
      // The live name vanished: a rotation unlinked it and no event has recreated it yet.
      if (ino !== undefined) drainRotated(ino, offset, carry);
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

      if (recreated) drainRotated(ino as number, offset, carry);

      if (recreated || stat.size < offset) {
        offset = 0;
        carry = '';
      }
      ino = stat.ino;

      ({ offset, carry } = drain(fd, offset, stat.size, carry));
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
