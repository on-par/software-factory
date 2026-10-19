import type { QueueSnapshot } from '@on-par/factory-core/internal';
import type { QueueListJson } from './json-contract.js';

/** `factory queue list --json` payload (#2268); additive changes bump schemaVersion only when breaking. */
export type { QueueListJson } from './json-contract.js';

/** One item in `factory queue list --json` (#2268). */
export type QueueListItemJson = QueueListJson['lanes'][number]['items'][number];

/** Duplicated order positions or skipped issues; `order` is null for a skipped issue (#3101, #3192). */
export type QueueListOrderConflictJson = QueueListJson['orderConflicts'][number];

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
  const orderConflicts = (snapshot.orderConflicts ?? [])
    .filter((c) => lane === undefined || c.lane === lane)
    .map((c) => ({
      lane: c.lane,
      order: c.position,
      issues: c.issues,
      ...(c.reason === undefined ? {} : { reason: c.reason }),
    }));
  return { schemaVersion: 1, lanes: [...byLane].map(([name, items]) => ({ lane: name, items })), orderConflicts };
}
