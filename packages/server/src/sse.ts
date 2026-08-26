// src/sse.ts — Pure SSE helpers for the lifecycle event stream (#592). No I/O:
// frame formatting, Last-Event-ID header parsing, and a bounded replay ring.
import type { LaneLifecycleEvent } from '@on-par/contracts';

/** Lifecycle event annotated with its attached repository at the server boundary. */
export type RepositoryLifecycleEvent = LaneLifecycleEvent & { repo: string };

/** SSE frame: `id:`, `event:`, one `data:` line of JSON, terminated by a blank line. */
export function formatSseFrame(id: number, event: RepositoryLifecycleEvent): string {
  return `id: ${id}\nevent: lifecycle\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Numeric resume cursor from a `Last-Event-ID` header. Returns undefined for a missing
 * header, an array-valued header, an empty/whitespace value, a non-integer, or a negative
 * number — the caller treats undefined as "no replay", never as an error.
 */
export function parseLastEventId(header: string | string[] | undefined): number | undefined {
  if (header === undefined || Array.isArray(header)) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export interface ReplayRing {
  push(id: number, event: RepositoryLifecycleEvent): void;
  since(lastId: number | undefined): Array<{ id: number; event: RepositoryLifecycleEvent }>;
  /** Number of retained entries — test/introspection only. */
  readonly size: number;
}

/** Entries retain push order; ids need not be globally ordered because they are repository-local. */
export function createReplayRing(capacity: number): ReplayRing {
  const cap = Math.max(1, capacity);
  const entries: Array<{ id: number; event: RepositoryLifecycleEvent }> = [];

  return {
    push(id, event) {
      entries.push({ id, event });
      if (entries.length > cap) entries.shift();
    },
    since(lastId) {
      if (lastId === undefined) return [];
      return entries.filter((entry) => entry.id > lastId);
    },
    get size() {
      return entries.length;
    },
  };
}
