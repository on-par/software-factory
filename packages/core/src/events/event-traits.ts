// src/events/event-traits.ts — the shape of an EventKind's classification; the table itself lives in kinds.ts.

import type { LogLevel } from '../types/index.js';

/** Lane state an event kind drives in the TUI/queue dashboard reducers; absent when the kind doesn't change it. */
export type LaneStatus = 'running' | 'waiting-merge' | 'ready' | 'merged' | 'failed' | 'parked' | 'stopped';

/** `severity` is widened to `'unknown'` only on the sentinel `UNKNOWN_EVENT_TRAITS`
 *  returned by `eventTraitsFor` for a string outside `EventKind` — every real
 *  `EVENT_TRAITS` entry uses a genuine `LogLevel`. */
export interface EventTraits {
  severity: LogLevel | 'unknown';
  /** Counts toward human-intervention KPIs (a lane that needs a human to look at it). */
  isPark: boolean;
  /** Ends the run/lane's current attempt (success or failure). */
  isTerminal: boolean;
  laneStatus?: LaneStatus;
}
