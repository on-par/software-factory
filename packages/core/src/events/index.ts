// src/events/index.ts — Read and tail the .factory/events.ndjson append log

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import type { FactoryEvent } from '../types/index.js';

/** Parse all events currently in the file. Missing file → []. Malformed lines are skipped. */
export function readEvents(eventsFile: string): FactoryEvent[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, 'utf-8')
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

export interface FollowEventsOptions {
  /** Replay events already in the file before tailing (default true — the TUI needs history to derive phase state). */
  fromStart?: boolean;
  /** Poll interval ms (default 250). Tests pass ~10. */
  pollMs?: number;
  /** Opens the events file for one poll (default fs.openSync read-only). Tests
   *  wrap it to rotate the file just before the open. */
  openFile?: (path: string) => number;
}

/** Tail the events file. Returns a stop() function. Never throws for a missing file — waits for it to appear. */
export function followEvents(
  eventsFile: string,
  onEvent: (e: FactoryEvent) => void,
  opts: FollowEventsOptions = {},
): () => void {
  const { fromStart = true, pollMs = 250, openFile = (path: string) => openSync(path, 'r') } = opts;

  let offset = 0;
  let carry = '';
  let ino: number | undefined;

  if (!fromStart) {
    try {
      const stat = statSync(eventsFile);
      offset = stat.size;
      ino = stat.ino;
    } catch {
      offset = 0;
    }
  }

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

      if (recreated || stat.size < offset) {
        offset = 0;
        carry = '';
      }
      ino = stat.ino;

      if (stat.size <= offset) return;

      const toRead = stat.size - offset;
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, offset);
      offset += bytesRead;

      const chunk = carry + buf.toString('utf-8', 0, bytesRead);
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
