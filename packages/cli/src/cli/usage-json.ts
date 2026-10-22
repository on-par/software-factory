import type { SubscriptionUsage } from '@on-par/factory-core';
import { TRAILING_WINDOW_MS } from '@on-par/factory-core/internal';
import type { UsageJson } from './json-contract.js';

/** `factory usage --json` payload (#2270); absent readings are null, never 0 (ADR-0099). */
export type { UsageJson } from './json-contract.js';

/** Hours in the trailing usage window `factory usage` reports on. */
export const USAGE_WINDOW_HOURS = TRAILING_WINDOW_MS / 3_600_000;

export type UsageJsonSource = UsageJson['source'];

/** Builds the `factory usage --json` payload: the real subscription reading when present, else the
 *  list-price heuristic against `cap`, else an explicit `unavailable` record. Numbers are not rounded.
 *  `plan` (#3214) is the detected billing plan and rides on every source. */
export function buildUsageJson(
  subscription: SubscriptionUsage | null,
  estimateUsd: number | null,
  cap: number,
  plan: UsageJson['plan'],
): UsageJson {
  if (subscription !== null) {
    return {
      schemaVersion: 1,
      source: 'subscription',
      utilizationPct: subscription.fiveHourUtilization,
      resetsAt: subscription.fiveHourResetsAt,
      windowHours: USAGE_WINDOW_HOURS,
      estimateUsd,
      plan,
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
      plan,
    };
  }
  return {
    schemaVersion: 1,
    source: 'unavailable',
    utilizationPct: null,
    resetsAt: null,
    windowHours: USAGE_WINDOW_HOURS,
    estimateUsd: null,
    plan,
  };
}
