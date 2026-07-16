import type { JSX } from 'react';
import { Box, Text } from 'ink';
import type { QueueSnapshot } from '@on-par/factory-core';
import type { LaneState, LaneStatus } from '../dashboard.js';

const TITLE_MAX_LENGTH = 40;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const STATUS_COLOR: Record<LaneStatus | 'queued', string | undefined> = {
  running: 'yellow',
  ready: 'green',
  'waiting-merge': 'yellow',
  merged: 'green',
  failed: 'red',
  stopped: undefined,
  queued: undefined,
};

export interface QueueTabProps {
  snapshot: QueueSnapshot;
  lanes: LaneState[];
}

export function QueueTab({ snapshot, lanes }: QueueTabProps): JSX.Element {
  if (snapshot.entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>queue is empty</Text>
      </Box>
    );
  }

  const laneByIssue = new Map(lanes.map((l) => [l.issue, l]));

  return (
    <Box flexDirection="column">
      {snapshot.entries.map((entry, i) => {
        const lane = laneByIssue.get(String(entry.issue));
        const status: LaneStatus | 'queued' = lane?.status ?? 'queued';
        return (
          <Text key={`${entry.lane}-${entry.issue}`}>
            {String(i + 1).padStart(3, ' ')}. {entry.lane} <Text bold>#{entry.issue}</Text>{' '}
            <Text color={STATUS_COLOR[status]}>{status}</Text> {truncate(lane?.title ?? '', TITLE_MAX_LENGTH)}
          </Text>
        );
      })}
      {typeof snapshot.proposedCount === 'number' && snapshot.proposedCount > 0 && (
        <Text dimColor>{snapshot.proposedCount} proposed issue(s) awaiting: factory triage accept</Text>
      )}
    </Box>
  );
}
