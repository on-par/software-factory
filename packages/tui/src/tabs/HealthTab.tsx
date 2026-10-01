import { computeHealthKpis, type CostEntry, type FactoryEvent, formatKpiLines } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import { type JSX, useMemo } from 'react';

import {
  filterToWindow,
  formatHealthHeadline,
  HEALTH_WINDOW_LABELS,
  type HealthWindowName,
  resolveHealthWindowStart,
} from './health-window.js';

export interface BreakerRow {
  provider: string;
  reason: string;
  remainingMs: number;
}

export interface HealthTabProps {
  events: FactoryEvent[];
  costs: CostEntry[];
  breakers: BreakerRow[];
  effectiveConfigLines: string[];
  showSecondary: boolean;
  window: HealthWindowName;
  runStartedAt?: string;
  now: number;
}

export function HealthTab({
  events,
  costs,
  breakers,
  effectiveConfigLines,
  showSecondary,
  window,
  runStartedAt,
  now,
}: HealthTabProps): JSX.Element {
  const startMs = resolveHealthWindowStart(window, runStartedAt, now);
  // Bucket 24h starts to the minute so the 500ms `now` tick doesn't recompute every frame.
  const memoStart = startMs === null ? null : window === '24h' ? Math.floor(startMs / 60_000) * 60_000 : startMs;
  const kpis = useMemo(() => {
    const w = filterToWindow(events, costs, memoStart);
    return computeHealthKpis(w.events, w.costs);
  }, [events, costs, memoStart]);
  const headline = formatHealthHeadline(kpis);
  const kpiLines = formatKpiLines(kpis);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Health — {HEALTH_WINDOW_LABELS[window]}</Text>
        <Text dimColor> w window · e details</Text>
      </Box>
      {breakers.length === 0 ? (
        <Text>{'Breaker:'.padEnd(22)}closed</Text>
      ) : (
        breakers.map((b) => (
          <Text key={b.provider} color="yellow">
            {'Breaker:'.padEnd(22)}
            {b.provider}: OPEN ({b.reason}) — {Math.ceil(b.remainingMs / 60_000)}m remaining
          </Text>
        ))
      )}
      {headline.map((row) => (
        <Text key={row.label}>{row.label.padEnd(22) + row.value}</Text>
      ))}
      <Text> </Text>
      {showSecondary ? (
        <>
          <Text bold>Effective config:</Text>
          {effectiveConfigLines.length === 0 ? (
            <Text dimColor>(unavailable)</Text>
          ) : (
            effectiveConfigLines.map((line, i) => <Text key={i}>{line}</Text>)
          )}
          <Text> </Text>
          <Text bold>KPIs:</Text>
          {kpiLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </>
      ) : (
        <Text dimColor>(Effective config and full KPIs hidden — press e to view)</Text>
      )}
    </Box>
  );
}
