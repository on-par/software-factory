import { Box, Text } from 'ink';
import type { JSX } from 'react';

import type { LaneFailureEvidence } from '../dashboard.js';
import type { RunState } from '../state.js';
import { EventFeed } from './EventFeed.js';
import { Header } from './Header.js';
import { PhaseRow } from './PhaseRow.js';

export interface RunDetailProps {
  run: RunState;
  repo?: string;
  now: number;
  showBackHint?: boolean;
  steeringQueued?: number;
  failureEvidence?: LaneFailureEvidence;
}

export function RunDetail({
  run,
  repo,
  now,
  showBackHint,
  steeringQueued,
  failureEvidence,
}: RunDetailProps): JSX.Element {
  const hasEvents = run.feed.length > 0;

  return (
    <Box flexDirection="column">
      <Header issue={run.issue} repo={repo} done={run.done} />
      {hasEvents ? <PhaseRow state={run} now={now} /> : <Text dimColor>waiting for factory events…</Text>}
      {failureEvidence && (
        <>
          <Text>{`failure reason: ${failureEvidence.reason}`}</Text>
          <Text>{`failure fingerprint: ${failureEvidence.fingerprint}`}</Text>
        </>
      )}
      {!!steeringQueued && (
        <Text dimColor>{`steering: ${steeringQueued} message(s) queued for next phase boundary`}</Text>
      )}
      <EventFeed events={run.feed} />
      {showBackHint && <Text dimColor>esc back · q quit</Text>}
    </Box>
  );
}
