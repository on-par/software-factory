// src/events/queue-traits.ts — EventKind members and EVENT_TRAITS entries for queue issue-placement events; spread into
// the table in kinds.ts (split out to keep kinds.ts under its max-lines ceiling).

import type { EventTraits } from './event-traits.js';

export type QueueEventKind = 'issue_deferred' | 'issue_unparked' | 'order_collision_repaired';

export const QUEUE_EVENT_TRAITS: Record<QueueEventKind, EventTraits> = {
  issue_deferred: { severity: 'info', isPark: false, isTerminal: false },
  issue_unparked: { severity: 'info', isPark: false, isTerminal: false },
  // #3147: an enqueue moved an issue off an order position another lane member held.
  order_collision_repaired: { severity: 'info', isPark: false, isTerminal: false },
};
