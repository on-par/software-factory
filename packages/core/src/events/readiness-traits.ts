import type { EventTraits } from './event-traits.js';

export type ReadinessEventKind =
  | 'not-ready'
  | 'readiness'
  | 'readiness_enrichment_failed'
  | 'readiness_enrichment_started'
  | 'readiness_enrichment_succeeded';

export const READINESS_EVENT_TRAITS: Record<ReadinessEventKind, EventTraits> = {
  'not-ready': { severity: 'warn', isPark: true, isTerminal: true, laneStatus: 'parked' },
  readiness: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_failed: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_started: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_succeeded: { severity: 'info', isPark: false, isTerminal: false },
};
