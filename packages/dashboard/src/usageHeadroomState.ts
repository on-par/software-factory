import type { UsageSource } from '@on-par/factory-core';

export interface UsageHeadroomReading {
  /** Fraction of the cap, 0..1, the same units as core's `UsageReading.pct`. */
  pct: number;
  /** USD cap the reading is measured against, as resolved by `resolveUsageCap`. */
  cap: number;
  source: UsageSource;
  /** ISO-8601 timestamp of the usage watchdog's next poll. */
  nextPollAt: string;
}

export const USAGE_UNAVAILABLE_REASON =
  'Usage signal unavailable — no reading, so the usage watchdog is not gating this run.';

export type UsageHeadroomView =
  | {
      available: true;
      pctLabel: string;
      capLabel: string;
      sourceLabel: string;
      nextPollLabel: string;
      pctValue: number;
    }
  | { available: false; reason: string };

const SOURCE_LABEL: Record<UsageSource, string> = {
  subscription: 'subscription signal (% of plan limit)',
  estimate: 'list-price estimate',
};

export function toUsageHeadroomView(reading: UsageHeadroomReading | null): UsageHeadroomView {
  if (reading === null) {
    return { available: false, reason: USAGE_UNAVAILABLE_REASON };
  }

  const pctValue = Math.round(reading.pct * 100);
  const ms = Date.parse(reading.nextPollAt);
  const nextPollLabel = Number.isNaN(ms) ? 'unknown' : `${new Date(ms).toISOString().slice(11, 19)} UTC`;

  return {
    available: true,
    pctValue,
    pctLabel: `${pctValue}%`,
    capLabel: `$${Math.round(reading.cap)}`,
    sourceLabel: SOURCE_LABEL[reading.source],
    nextPollLabel,
  };
}
