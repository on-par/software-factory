import type { QueueSnapshot } from '@on-par/factory-core';

import type { LaneState } from './dashboard.js';

export type LaneQueueRow =
  | { kind: 'queued'; issue: string; title?: string; position: number }
  | { kind: 'parked'; issue: string; title?: string };

export interface LaneQueueView {
  rows: LaneQueueRow[];
  /** Set when the queue read failed; rows is then empty. */
  unavailable?: string;
}

/** The lane view's queue join (#1744): one lane's queued/parked issues the event log has not seen yet. */
export function laneQueueRows(lane: string, snapshot: QueueSnapshot, laneIssues: readonly LaneState[]): LaneQueueView {
  if (snapshot.error !== undefined) return { rows: [], unavailable: snapshot.error };
  const known = new Set(laneIssues.map((l) => l.issue));
  const rows: LaneQueueRow[] = [];
  let position = 0;
  for (const entry of snapshot.entries) {
    if (entry.lane !== lane || known.has(String(entry.issue))) continue;
    const issue = String(entry.issue);
    const title = entry.title !== undefined ? { title: entry.title } : {};
    if (entry.status === 'parked') rows.push({ kind: 'parked', issue, ...title });
    else if (entry.status !== 'in-progress') rows.push({ kind: 'queued', issue, ...title, position: ++position });
  }
  return { rows };
}
