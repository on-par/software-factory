import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { laneElapsedMs, type LaneState } from '../dashboard.js';
import { formatDuration, spinnerFrame } from './PhaseRow.js';

const TITLE_MAX_LENGTH = 32;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function StatusCell({
  lane,
  now,
  trainPosition,
}: {
  lane: LaneState;
  now: number;
  trainPosition?: number;
}): JSX.Element {
  switch (lane.status) {
    case 'running':
      return (
        <Text>
          <Text color="yellow">{spinnerFrame(now)}</Text> {lane.run.activePhase ?? '?'}
        </Text>
      );
    case 'ready':
      return <Text color="green">✔ ready{lane.prNumber ? ` PR #${lane.prNumber}` : ''}</Text>;
    case 'waiting-merge':
      return (
        <Text color="yellow">
          ⏳ waiting to merge{trainPosition !== undefined ? ` (#${trainPosition} in train)` : ''}
        </Text>
      );
    case 'merged':
      return <Text color="green">✔ merged PR #{lane.prNumber ?? '?'}</Text>;
    case 'failed':
      return <Text color="red">✖ {lane.failedPhase ?? 'FAILED'}</Text>;
    case 'stopped':
      return <Text dimColor>■ stopped</Text>;
  }
}

export interface LaneRowProps {
  lane: LaneState;
  selected: boolean;
  now: number;
  trainPosition?: number;
}

export function LaneRow({ lane, selected, now, trainPosition }: LaneRowProps): JSX.Element {
  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
      <StatusCell lane={lane} now={now} trainPosition={trainPosition} />
      <Text>
        {' '}
        <Text bold>#{lane.issue}</Text> {truncate(lane.title ?? '', TITLE_MAX_LENGTH)}{' '}
        <Text dimColor>{lane.run.model ?? '?'}</Text> {formatDuration(laneElapsedMs(lane, now))}
      </Text>
    </Box>
  );
}
