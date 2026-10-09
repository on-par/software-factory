import type { QueueSnapshot } from '@on-par/factory-core/internal';

/** One item in `factory queue list --json` (#2268). */
export interface QueueListItemJson {
  issue: number;
  title?: string;
  status: 'queued' | 'in-progress' | 'parked';
  /** 1-based position within the lane, in order-label order. */
  order: number;
  claimedBy: string | null;
}

/** `factory queue list --json` payload (#2268). Additive changes only; bump schemaVersion on a breaking change. */
export interface QueueListJson {
  schemaVersion: 1;
  lanes: Array<{ lane: string; items: QueueListItemJson[] }>;
}

/**
 * Group the reader's already-sorted entries by lane (lane order preserved) and
 * rank each item 1-based within its lane. `lane` keeps only that lane.
 */
export function buildQueueListJson(snapshot: QueueSnapshot, lane?: string): QueueListJson {
  const byLane = new Map<string, QueueListItemJson[]>();
  for (const entry of snapshot.entries) {
    if (lane !== undefined && entry.lane !== lane) continue;
    let items = byLane.get(entry.lane);
    if (items === undefined) {
      items = [];
      byLane.set(entry.lane, items);
    }
    items.push({
      issue: entry.issue,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      status: entry.status ?? 'queued',
      order: items.length + 1,
      claimedBy: entry.claimant ?? null,
    });
  }
  return { schemaVersion: 1, lanes: [...byLane].map(([name, items]) => ({ lane: name, items })) };
}
