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
}

export function Dashboard({ state, selectedIndex, now, repo, stopReason }: DashboardProps): JSX.Element {
  const headerText = `Factory —${repo ? ` ${repo} ·` : ''} ${state.lanes.length} lane(s)`;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {headerText}
      </Text>
      {stopReason && <StopBanner reason={stopReason} />}
      {state.lanes.length === 0 ? (
        <Text dimColor>waiting for factory events…</Text>
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
      <Text dimColor>↑/↓ select · ⏎ detail · q quit</Text>
    </Box>
  );
}
