import { computeHealthKpis, type CostEntry, type FactoryEvent, formatKpiLines } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import { type JSX, useMemo } from 'react';

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
}

export function HealthTab({
  events,
  costs,
  breakers,
  effectiveConfigLines,
  showSecondary,
}: HealthTabProps): JSX.Element {
  const kpiLines = useMemo(() => formatKpiLines(computeHealthKpis(events, costs)), [events, costs]);

  return (
    <Box flexDirection="column">
      <Text bold>Provider breaker:</Text>
      {breakers.length === 0 ? (
        <Text dimColor>(closed)</Text>
      ) : (
        breakers.map((b) => (
          <Text key={b.provider} color="yellow">
            {b.provider}: OPEN ({b.reason}) — {Math.ceil(b.remainingMs / 60_000)}m remaining
          </Text>
        ))
      )}
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
        <Text dimColor>(Effective config and KPIs hidden — press e to view)</Text>
      )}
    </Box>
  );
}
