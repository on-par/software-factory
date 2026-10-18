import type { QueueOrderLabelProblem, QueueSnapshot } from '@on-par/factory-core/internal';

/** One item in `factory queue list --json` (#2268). */
export interface QueueListItemJson {
  issue: number;
  title?: string;
  status: 'queued' | 'in-progress' | 'parked';
  /** 1-based rank within the lane after sorting by the factory:order label (ties broken by issue number) — not the label value (#3101). */
  order: number;
  claimedBy: string | null;
}

/** A duplicated `factory:order:<n>` position in one lane (#3101), or a skipped issue with a missing or malformed order label (#3192); `order` is the label value, null for a skipped issue. */
export interface QueueListOrderConflictJson {
  lane: string;
  order: number | null;
  issues: number[];
  reason?: QueueOrderLabelProblem;
}

/** `factory queue list --json` payload (#2268). Additive changes only; bump schemaVersion on a breaking change. */
export interface QueueListJson {
  schemaVersion: 1;
  lanes: Array<{ lane: string; items: QueueListItemJson[] }>;
  /** Duplicated order positions and skipped malformed-label issues (#3192), filtered by `--lane`; additive, present since #3101. */
  orderConflicts: QueueListOrderConflictJson[];
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
