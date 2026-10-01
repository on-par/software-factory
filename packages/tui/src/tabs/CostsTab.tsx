import { formatCostTotal, type CostsRead } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import { type JSX, useMemo } from 'react';

import type { LaneState } from '../dashboard.js';
import { formatTokensShort, resolveCostsSelection, summarizeRunCosts, truncateSegments } from './run-costs.js';

export interface CostsTabProps {
  costs: CostsRead;
  /** Current-run lanes from DashboardState (state.lanes, not the stale-filtered set). */
  lanes: LaneState[];
  selectedIssue?: string;
  expanded?: boolean;
  width?: number;
}

const usd = (cost: number | null, unpriced: number): string => formatCostTotal(cost, unpriced, 2);

export function CostsTab({ costs, lanes, selectedIssue, expanded = false, width = 100 }: CostsTabProps): JSX.Element {
  const summary = useMemo(() => summarizeRunCosts(costs.entries, lanes), [costs.entries, lanes]);
  const warning = costs.skipped > 0 && (
    <Text color="yellow">⚠ skipped {costs.skipped} malformed line(s) in costs.jsonl</Text>
  );

  if (costs.entries.length === 0) {
    return (
      <Box flexDirection="column">
        {warning}
        <Text dimColor>no cost data yet</Text>
      </Box>
    );
  }

  const allTime = (
    <Text dimColor>All-time (costs.jsonl): {usd(summary.allTime.cost, summary.allTime.unpricedCount)}</Text>
  );

  if (summary.runStartedAt === undefined || summary.issues.length === 0) {
    return (
      <Box flexDirection="column">
        {warning}
        <Text dimColor>{summary.runStartedAt === undefined ? 'no active run' : 'no cost rows this run yet'}</Text>
        {allTime}
      </Box>
    );
  }

  const currentId = resolveCostsSelection(summary, lanes, selectedIssue);
  const current = summary.issues.find((i) => i.issue === currentId) ?? summary.issues[0];
  const { total } = summary;

  return (
    <Box flexDirection="column">
      {warning}
      <Text>
        <Text bold>Spent this run:</Text> {usd(total.cost, total.unpricedCount)} · in{' '}
        {formatTokensShort(total.inputTokens)} · out {formatTokensShort(total.outputTokens)}
      </Text>
      <Text>
        Median / merged PR:{' '}
        {summary.medianMergedCost === null
          ? '— (0 merged)'
          : `${usd(summary.medianMergedCost, 0)} (n=${summary.mergedCount})`}
      </Text>
      <Text>
        {truncateSegments(
          'By lane: ',
          summary.byLane.map((l) => `${l.lane} ${usd(l.cost, l.unpricedCount)}`),
          width,
        )}
      </Text>
      <Text>
        {truncateSegments(
          'By issue: ',
          summary.issues.map((i) => `#${i.issue} ${usd(i.cost, i.unpricedCount)}`),
          width,
        )}
      </Text>
      <Text>
        <Text color="cyan">❯ </Text>#{current.issue} (lane {current.lane}) {usd(current.cost, current.unpricedCount)} ·
        in {formatTokensShort(current.inputTokens)} · out {formatTokensShort(current.outputTokens)}{' '}
        <Text dimColor>— ↑↓ select · {expanded ? 'esc close' : '⏎ per-model'}</Text>
      </Text>
      {expanded && (
        <>
          <Text bold>per-model — #{current.issue}</Text>
          {current.perModel.map((m) => (
            <Text key={m.model}>
              {'  '}
              {m.model} {m.tasks} task(s) in {formatTokensShort(m.inputTokens)} out {formatTokensShort(m.outputTokens)}{' '}
              {usd(m.cost, m.unpricedCount)}
            </Text>
          ))}
        </>
      )}
      <Text> </Text>
      {allTime}
    </Box>
  );
}
