import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { type DashboardState, mergeTrainPosition } from '../dashboard.js';
import { LaneRow } from './LaneRow.js';
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
  const headerText = `Factory —${repo ? ` ${repo} ·` : ''} ${state.lanes.length} lane(s)`;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {headerText}
      </Text>
      {stopReason && <StopBanner reason={stopReason} />}
      {state.lanes.length === 0 ? (
        <Text dimColor>(idle — no active claims)</Text>
      ) : (
        state.lanes.map((lane, i) => (
          <LaneRow
            key={lane.issue}
            lane={lane}
            selected={i === selectedIndex}
            now={now}
            trainPosition={mergeTrainPosition(state, lane.issue)}
          />
        ))
      )}
      {staleCount > 0 && <Text dimColor>{staleLanesLine(staleCount)}</Text>}
      <Text dimColor>↑/↓ select · ⏎ detail · q quit</Text>
    </Box>
  );
}
