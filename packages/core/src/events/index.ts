// src/events/index.ts — Read and tail the .factory/events.ndjson append log

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import type { FactoryEvent } from '../types/index.js';
import { findEventSegmentByIno, listEventSegmentPaths } from './tail.js';

function parseFile(path: string): FactoryEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
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
 *  `includeSegments` prepends the rotated segments (oldest first) for full-history readers (#1631). */
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

  const emitLines = (chunk: string): string => {
    const lines = chunk.split('\n');
    const rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as FactoryEvent);
      } catch {
        // skip malformed line
      }
    }
    return rest;
  };

  /** Read [from, size) of an open fd, emit its complete lines, and return the new offset and carry. */
  const readFrom = (fd: number, size: number, from: number, prevCarry: string): { offset: number; carry: string } => {
    if (size <= from) return { offset: from, carry: prevCarry };
    const toRead = size - from;
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, from);
    return { offset: from + bytesRead, carry: emitLines(prevCarry + buf.toString('utf-8', 0, bytesRead)) };
  };

  const readWholePath = (path: string, from: number, prevCarry: string): void => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      readFrom(fd, fstatSync(fd).size, from, prevCarry);
    } finally {
      closeSync(fd);
    }
  };

  // The file we were reading went missing (rotation renamed it and the logger has not recreated it yet).
  let pending: { ino: number; offset: number; carry: string } | undefined;

  const drainRotated = (prev: { ino: number; offset: number; carry: string }): void => {
    const found = findEventSegmentByIno(eventsFile, prev.ino);
    if (!found) return;
    readWholePath(found.path, prev.offset, prev.carry);
    for (const path of found.newer) readWholePath(path, 0, '');
  };

  const tick = (): void => {
    // Open first and take size/inode from the open fd, so the stat and the
    // read always describe the same file even if it is rotated in between.
    let fd: number;
    try {
      fd = openFile(eventsFile);
    } catch {
      // Missing file: treat it as empty so a recreated file is read from the start.
      if (ino !== undefined && !pending) pending = { ino, offset, carry };
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

      const prev = recreated ? { ino: ino as number, offset, carry } : pending;
      if (prev && prev.ino !== stat.ino) drainRotated(prev);
      pending = undefined;

      if (recreated || stat.size < offset) {
        offset = 0;
        carry = '';
      }
      ino = stat.ino;

      ({ offset, carry } = readFrom(fd, stat.size, offset, carry));
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
