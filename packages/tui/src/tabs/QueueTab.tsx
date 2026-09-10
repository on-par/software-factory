import type { QueueEntryStatus, QueueSnapshot } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import type { JSX } from 'react';

import type { LaneState, LaneStatus } from '../dashboard.js';

const TITLE_MAX_LENGTH = 40;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type RowStatus = LaneStatus | QueueEntryStatus;

const STATUS_COLOR: Record<RowStatus, string | undefined> = {
  running: 'yellow',
  ready: 'green',
  'waiting-merge': 'yellow',
  merged: 'green',
  failed: 'red',
  parked: 'yellow',
  stopped: undefined,
  queued: undefined,
  'in-progress': 'yellow',
};

export interface QueueTabProps {
  snapshot: QueueSnapshot;
  lanes: LaneState[];
  /** Source name for the heading ("GitHub" / "local file"); omitted when the App has no queue reader. */
  source?: string;
}

export function QueueTab({ snapshot, lanes, source }: QueueTabProps): JSX.Element {
  const heading = source === undefined ? undefined : <Text dimColor>queue: {source}</Text>;
  const error = snapshot.error === undefined ? undefined : <Text color="red">({snapshot.error})</Text>;

  if (snapshot.entries.length === 0) {
    return (
      <Box flexDirection="column">
        {heading}
        {error ?? <Text dimColor>queue is empty</Text>}
      </Box>
    );
  }

  const laneByIssue = new Map(lanes.map((l) => [l.issue, l]));

  return (
    <Box flexDirection="column">
      {heading}
      {error}
      {snapshot.entries.map((entry, i) => {
        // A live lane (from the event log) knows more than a label does, so it wins; a snapshot
        // status/title from GitHub fills in for issues no lane has touched yet.
        const lane = laneByIssue.get(String(entry.issue));
        const status: RowStatus = lane?.status ?? entry.status ?? 'queued';
        const claimant = lane === undefined && entry.claimant !== undefined ? ` (${entry.claimant})` : '';
        const title = lane?.title ?? entry.title ?? '';
        return (
          <Text key={`${entry.lane}-${entry.issue}`}>
            {String(i + 1).padStart(3, ' ')}. {entry.lane} <Text bold>#{entry.issue}</Text>{' '}
            <Text color={STATUS_COLOR[status]}>
              {status}
              {claimant}
            </Text>{' '}
            {truncate(title, TITLE_MAX_LENGTH)}
          </Text>
        );
      })}
      {typeof snapshot.proposedCount === 'number' && snapshot.proposedCount > 0 && (
        <Text dimColor>{snapshot.proposedCount} proposed issue(s) awaiting: factory triage accept</Text>
      )}
    </Box>
  );
}
