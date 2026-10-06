import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { type DashboardState, lanesOf } from '../dashboard.js';
import { LaneList } from './LaneList.js';
import { StopBanner } from './StopBanner.js';

export interface DashboardProps {
  state: DashboardState;
  selectedIndex: number;
  now: number;
  repo?: string;
  stopReason?: string;
  /** Lanes hidden as stale by partitionLanesByActivity; rendered as a one-line footer when > 0. */
  staleCount?: number;
}

/** Header counts: distinct lanes, plus the issue count when it differs (#1736). */
export function laneCountsLine(state: DashboardState): string {
  const lanes = lanesOf(state).length;
  const issues = state.lanes.length;
  const laneText = `${lanes} lane${lanes === 1 ? '' : 's'}`;
  return issues === lanes ? laneText : `${laneText} · ${issues} issue${issues === 1 ? '' : 's'}`;
}

export function staleLanesLine(staleCount: number): string {
  return `(${staleCount} stale lane${staleCount === 1 ? '' : 's'} hidden — no activity for 15m; run factory doctor --reconcile)`;
}

export function Dashboard({
  state,
  selectedIndex,
  now,
  repo,
  stopReason,
  staleCount = 0,
}: DashboardProps): JSX.Element {
  const headerText = `Factory —${repo ? ` ${repo} ·` : ''} ${laneCountsLine(state)}`;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {headerText}
      </Text>
      {stopReason && <StopBanner reason={stopReason} />}
      {state.lanes.length === 0 ? (
        <Text dimColor>(idle — no active claims)</Text>
      ) : (
        <LaneList groups={lanesOf(state)} selectedIndex={selectedIndex} now={now} state={state} />
      )}
      {staleCount > 0 && <Text dimColor>{staleLanesLine(staleCount)}</Text>}
      <Text dimColor>↑/↓ select · ⏎ open lane · q quit</Text>
    </Box>
  );
}
