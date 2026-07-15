// src/events/index.ts — Read and tail the .factory/events.ndjson append log

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { FactoryEvent } from '../types/index.js';

/** Parse all events currently in the file. Missing file → []. Malformed lines are skipped. */
export function readEvents(eventsFile: string): FactoryEvent[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
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
}

/** Tail the events file. Returns a stop() function. Never throws for a missing file — waits for it to appear. */
export function followEvents(
  eventsFile: string,
  onEvent: (e: FactoryEvent) => void,
  opts: FollowEventsOptions = {},
): () => void {
  const { fromStart = true, pollMs = 250 } = opts;

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
    let size: number;
    let currentIno: number | undefined;
    try {
      const stat = statSync(eventsFile);
      size = stat.size;
      currentIno = stat.ino;
    } catch {
      size = 0;
    }

    // A changed inode means the file was deleted and recreated (e.g. log
    // rotation) — comparing size alone can miss this if the new file already
    // reached or exceeded the old offset before the next poll.
    const recreated = ino !== undefined && currentIno !== undefined && currentIno !== ino;

    if (recreated || size < offset) {
      offset = 0;
      carry = '';
    }
    ino = currentIno;

    if (size > offset) {
      const toRead = size - offset;
      const buf = Buffer.alloc(toRead);
      const fd = openSync(eventsFile, 'r');
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, buf, 0, toRead, offset);
      } finally {
        closeSync(fd);
      }
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
