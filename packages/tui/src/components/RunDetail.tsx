import type { JSX } from 'react';
import { Box, Text } from 'ink';
import type { RunState } from '../state.js';
import { Header } from './Header.js';
import { PhaseRow } from './PhaseRow.js';
import { EventFeed } from './EventFeed.js';

export interface RunDetailProps {
  run: RunState;
  repo?: string;
  now: number;
  showBackHint?: boolean;
}

export function RunDetail({ run, repo, now, showBackHint }: RunDetailProps): JSX.Element {
  const hasEvents = run.feed.length > 0;

  return (
    <Box flexDirection="column">
      <Header issue={run.issue} repo={repo} done={run.done} />
      {hasEvents ? <PhaseRow state={run} now={now} /> : <Text dimColor>waiting for factory events…</Text>}
      <EventFeed events={run.feed} />
      {showBackHint && <Text dimColor>esc back · q quit</Text>}
    </Box>
  );
}
