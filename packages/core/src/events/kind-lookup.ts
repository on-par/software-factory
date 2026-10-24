// src/events/kind-lookup.ts — EVENT_TRAITS lookups, split out of kinds.ts to stay under the max-lines ceiling

import { EVENT_TRAITS, type EventKind } from './kinds.js';
import type { EventTraits, LaneStatus } from './event-traits.js';
import type { LogLevel } from '../types/index.js';

/** Returned by `eventTraitsFor` for a string outside `EventKind` (e.g. from an older factory version).
 *  Deliberately not `info`: an unrecognized kind must never silently read as routine/successful. */
export const UNKNOWN_EVENT_TRAITS: EventTraits = { severity: 'unknown', isPark: false, isTerminal: false };

function isEventKind(type: string): type is EventKind {
  return Object.hasOwn(EVENT_TRAITS, type);
}

/** Classifies a FactoryEvent kind, returning UNKNOWN_EVENT_TRAITS for unknown strings. */
export function eventTraitsFor(type: string): EventTraits {
  return isEventKind(type) ? EVENT_TRAITS[type] : UNKNOWN_EVENT_TRAITS;
}

/** `LogLevel` for a kind; unknown kinds map to `'info'` (the historical default, so old unrecognized kinds aren't flagged). */
export function severityOf(type: string): LogLevel {
  const { severity } = eventTraitsFor(type);
  return severity === 'unknown' ? 'info' : severity;
}

/** Whether this kind counts toward human-intervention/park KPIs. */
export function isParkKind(type: string): boolean {
  return eventTraitsFor(type).isPark;
}

/** Lane status this kind drives in a lane-state reducer, or undefined when it doesn't change lane status. */
export function laneStatusOf(type: string): LaneStatus | undefined {
  return eventTraitsFor(type).laneStatus;
}
