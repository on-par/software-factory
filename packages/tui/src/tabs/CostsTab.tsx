import { aggregateCosts, type CostsRead } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import { type JSX, useMemo } from 'react';

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

export interface CostsTabProps {
  costs: CostsRead;
  selectedIndex: number;
}

export function CostsTab({ costs, selectedIndex }: CostsTabProps): JSX.Element {
  const summary = useMemo(() => aggregateCosts(costs.entries), [costs.entries]);

  if (summary.perIssue.length === 0) {
    return (
      <Box flexDirection="column">
        {costs.skipped > 0 && <Text color="yellow">⚠ skipped {costs.skipped} malformed line(s) in costs.jsonl</Text>}
        <Text dimColor>no cost data yet</Text>
      </Box>
    );
  }

  const clampedIndex = Math.min(selectedIndex, summary.perIssue.length - 1);
  const selected = summary.perIssue[clampedIndex];

  return (
    <Box flexDirection="column">
      {costs.skipped > 0 && <Text color="yellow">⚠ skipped {costs.skipped} malformed line(s) in costs.jsonl</Text>}
      <Text bold>issue in-tokens out-tokens cost</Text>
      {summary.perIssue.map((row, i) => (
        <Text key={row.issue}>
          <Text color={i === clampedIndex ? 'cyan' : undefined}>{i === clampedIndex ? '❯ ' : '  '}</Text>
          <Text inverse={i === clampedIndex}>
            #{row.issue} {fmtTokens(row.inputTokens)} {fmtTokens(row.outputTokens)} {fmtCost(row.cost)}
          </Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold>per-model — #{selected.issue}</Text>
      {selected.perModel.map((m) => (
        <Text key={m.model}>
          {' '}
          {m.model} {m.tasks} task(s) in {fmtTokens(m.inputTokens)} out {fmtTokens(m.outputTokens)} {fmtCost(m.cost)}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>
        session total: in {fmtTokens(summary.total.inputTokens)} · out {fmtTokens(summary.total.outputTokens)} ·{' '}
        {fmtCost(summary.total.cost)}
      </Text>
    </Box>
  );
}
