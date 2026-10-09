import type { SubscriptionUsage } from '@on-par/factory-core';
import { TRAILING_WINDOW_MS } from '@on-par/factory-core/internal';

/** Hours in the trailing usage window `factory usage` reports on. */
export const USAGE_WINDOW_HOURS = TRAILING_WINDOW_MS / 3_600_000;

export type UsageJsonSource = 'subscription' | 'heuristic' | 'unavailable';

/** `factory usage --json` payload (#2270). Absent readings are null, never 0 (ADR-0099).
 *  Additive changes only; bump schemaVersion on a breaking change. */
export interface UsageJson {
  schemaVersion: 1;
  source: UsageJsonSource;
  /** Percent of the window used, 0-100 scale. */
  utilizationPct: number | null;
  resetsAt: string | null;
  windowHours: number;
  /** Trailing-window list-price estimate in USD. */
  estimateUsd: number | null;
}

/** Builds the `factory usage --json` payload: the real subscription reading when present, else the
 *  list-price heuristic against `cap`, else an explicit `unavailable` record. Numbers are not rounded. */
export function buildUsageJson(
  subscription: SubscriptionUsage | null,
  estimateUsd: number | null,
  cap: number,
): UsageJson {
  if (subscription !== null) {
    return {
      schemaVersion: 1,
      source: 'subscription',
      utilizationPct: subscription.fiveHourUtilization,
      resetsAt: subscription.fiveHourResetsAt,
      windowHours: USAGE_WINDOW_HOURS,
      estimateUsd,
    };
  }
  if (estimateUsd !== null) {
    return {
      schemaVersion: 1,
      source: 'heuristic',
      utilizationPct: (estimateUsd / cap) * 100,
      resetsAt: null,
      windowHours: USAGE_WINDOW_HOURS,
      estimateUsd,
    };
  }
  return {
    schemaVersion: 1,
    source: 'unavailable',
    utilizationPct: null,
    resetsAt: null,
    windowHours: USAGE_WINDOW_HOURS,
    estimateUsd: null,
  };
}
