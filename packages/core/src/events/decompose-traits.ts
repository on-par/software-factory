// src/events/decompose-traits.ts — EVENT_TRAITS entries for the decompose_* kinds; spread into the table in kinds.ts
// (split out to keep kinds.ts under its max-lines ceiling).

import type { EventKind } from './kinds.js';
import type { EventTraits } from './event-traits.js';

export const DECOMPOSE_EVENT_TRAITS: Record<Extract<EventKind, `decompose_${string}`>, EventTraits> = {
  decompose_comment_posted: { severity: 'info', isPark: false, isTerminal: false },
  decompose_duplicate_skipped: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_failed: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_file_failed: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_filed: { severity: 'info', isPark: false, isTerminal: false },
  // #728: decompose skipped — issue closed, or own proposal still awaiting a human decision.
  decompose_skipped: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_started: { severity: 'info', isPark: false, isTerminal: false },
};
