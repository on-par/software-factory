// src/kpis/park.ts — Open-parked count and park-to-human wait, from the event log (#3513)

import { isParkKind } from '../events/kinds.js';
import type { FactoryEvent } from '../types/index.js';
import { median } from '../utils/median.js';
import { hasUnresolvedPark, isHumanEvent } from './human.js';

export interface ParkKpis {
  openParked: number;
  parkToHumanSamples: number;
  medianParkToHumanMs: number | null;
}

/** Distinct real issues with an unresolved park, plus the median wait from a park to the first
 *  later `issue_unparked` or human-* event on the same issue. Events are grouped by issue first so
 *  the work stays linear in the log size. */
export function computeParkKpis(events: FactoryEvent[]): ParkKpis {
  const byIssue = new Map<string, FactoryEvent[]>();
  for (const event of events) {
    if (!/^\d+$/.test(event.issue)) continue;
    const list = byIssue.get(event.issue);
    if (list) list.push(event);
    else byIssue.set(event.issue, [event]);
  }

  let openParked = 0;
  const waits: number[] = [];
  for (const [issue, issueEvents] of byIssue) {
    if (hasUnresolvedPark(issueEvents, issue)) openParked++;
    const timed = issueEvents
      .map((e) => ({ e, ts: Date.parse(e.ts) }))
      .filter((x) => !Number.isNaN(x.ts))
      .sort((a, b) => a.ts - b.ts);
    let pending: number | null = null;
    for (const { e, ts } of timed) {
      if (isParkKind(e.type)) {
        pending ??= ts;
      } else if (pending !== null && ts > pending && (e.type === 'issue_unparked' || isHumanEvent(e))) {
        waits.push(ts - pending);
        pending = null;
      }
    }
  }
  return { openParked, parkToHumanSamples: waits.length, medianParkToHumanMs: median(waits) };
}
