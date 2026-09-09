import { Box, Text } from 'ink';
import type { JSX } from 'react';

import type { RunState } from '../state.js';
import { EventFeed } from './EventFeed.js';
import { Header } from './Header.js';
import { formatAgo, formatDuration, PhaseRow } from './PhaseRow.js';

export interface RunDetailProps {
  run: RunState;
  title?: string;
  repo?: string;
  now: number;
  elapsedMs?: number;
  lastActivityAt?: string;
  showBackHint?: boolean;
  steeringQueued?: number;
}

export function RunDetail({
  run,
  title,
  repo,
  now,
  elapsedMs,
  lastActivityAt,
  showBackHint,
  steeringQueued,
}: RunDetailProps): JSX.Element {
  const hasEvents = run.feed.length > 0;

  return (
    <Box flexDirection="column">
      <Header issue={run.issue} title={title} repo={repo} done={run.done} />
      {(elapsedMs !== undefined || lastActivityAt) && (
        <Text dimColor>
          {elapsedMs !== undefined && `elapsed ${formatDuration(elapsedMs)}`}
          {elapsedMs !== undefined && lastActivityAt ? ' · ' : ''}
          {lastActivityAt && `last activity ${formatAgo(now - Date.parse(lastActivityAt))}`}
        </Text>
      )}
      {hasEvents ? <PhaseRow state={run} now={now} /> : <Text dimColor>waiting for factory events…</Text>}
      {!!steeringQueued && (
        <Text dimColor>{`steering: ${steeringQueued} message(s) queued for next phase boundary`}</Text>
      )}
      <EventFeed events={run.feed} />
      {showBackHint && <Text dimColor>esc back · q quit</Text>}
    </Box>
  );
}
