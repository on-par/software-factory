import type { JSX } from 'react';
import { Box, Text } from 'ink';
import type { FactoryEvent } from '@on-par/factory-core';
import { isFailoverEvent } from '../state.js';

const MAX_MSG_LENGTH = 100;

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toISOString().slice(11, 19);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface EventFeedProps {
  events: FactoryEvent[];
}

export function EventFeed({ events }: EventFeedProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {events.map((e, i) => {
        const line = truncate(`${e.type} #${e.issue}: ${e.msg}`, MAX_MSG_LENGTH);
        const failover = isFailoverEvent(e);
        return (
          <Text key={`${e.ts}-${i}`} color={failover ? 'yellow' : undefined}>
            <Text dimColor>{formatTime(e.ts)}</Text> {line}
          </Text>
        );
      })}
    </Box>
  );
}
