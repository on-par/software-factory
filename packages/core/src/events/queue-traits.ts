// src/events/queue-traits.ts — EventKind members and EVENT_TRAITS entries for queue issue-placement events and PR-persisted run state (#3909); spread into
// the table in kinds.ts (split out to keep kinds.ts under its max-lines ceiling).

import type { EventTraits } from './event-traits.js';

export type QueueEventKind =
  | 'issue_deferred'
  | 'issue_unparked'
  | 'order_collision_repaired'
  | 'pr_state_loaded'
  | 'pr_state_ignored'
  | 'pr_state_failed';

export const QUEUE_EVENT_TRAITS: Record<QueueEventKind, EventTraits> = {
  issue_deferred: { severity: 'info', isPark: false, isTerminal: false },
  issue_unparked: { severity: 'info', isPark: false, isTerminal: false },
  // #3147: an enqueue moved an issue off an order position another lane member held.
  order_collision_repaired: { severity: 'info', isPark: false, isTerminal: false },
  // #3909: run state restored from, ignored on, or failing to reach the factory-owned PR comment (ADR-0174).
  pr_state_loaded: { severity: 'info', isPark: false, isTerminal: false },
  pr_state_ignored: { severity: 'warn', isPark: false, isTerminal: false },
  pr_state_failed: { severity: 'info', isPark: false, isTerminal: false },
};
