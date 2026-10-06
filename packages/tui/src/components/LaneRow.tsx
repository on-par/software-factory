import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { laneElapsedMs, type LaneState } from '../dashboard.js';
import { sanitizeTerminalText } from '../text.js';
import { formatDuration, spinnerFrame } from './PhaseRow.js';

const TITLE_MAX_LENGTH = 32;

function truncate(s: string, max: number): string {
  const clean = sanitizeTerminalText(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function phaseLabel(phase: string, round: number | undefined): string {
  return round && round > 0 ? `${phase} r${round}` : phase;
}

export function StatusCell({
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
          <Text color="yellow">{spinnerFrame(now)}</Text> {phaseLabel(lane.run.activePhase ?? '?', lane.reworkRound)}
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
      return <Text color="red">✖ {lane.failedPhase ? phaseLabel(lane.failedPhase, lane.reworkRound) : 'FAILED'}</Text>;
    case 'parked':
      return (
        <Text color="yellow">
          ⏸ parked{lane.failedPhase ? ` (${phaseLabel(lane.failedPhase, lane.reworkRound)})` : ''}
        </Text>
      );
    case 'stopped':
      return <Text dimColor>■ stopped</Text>;
  }
}

export interface LaneRowProps {
  lane: LaneState;
  selected: boolean;
  now: number;
  trainPosition?: number;
  /** Lane view only: append the park reason of a parked row. */
  showReason?: boolean;
}

export function LaneRow({ lane, selected, now, trainPosition, showReason }: LaneRowProps): JSX.Element {
  const reason = showReason && lane.status === 'parked' ? (lane.failureEvidence?.reason ?? lane.failReason) : undefined;
  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
      <StatusCell lane={lane} now={now} trainPosition={trainPosition} />
      <Text>
        {' '}
        <Text bold>#{lane.issue}</Text> {truncate(lane.title ?? '', TITLE_MAX_LENGTH)}{' '}
        <Text dimColor>{lane.run.model ?? '?'}</Text> {formatDuration(laneElapsedMs(lane, now))}
      </Text>
      {reason !== undefined && <Text dimColor> — {truncate(reason, TITLE_MAX_LENGTH)}</Text>}
    </Box>
  );
}
