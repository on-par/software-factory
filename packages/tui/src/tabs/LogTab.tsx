import type { JSX } from 'react';
import { Box, Text } from 'ink';
import type { FactoryEvent } from '@on-par/factory-core';
import { EventFeed } from '../components/EventFeed.js';
import { visibleSlice, type LogScrollState } from './log-scroll.js';

export interface LogTabProps {
  events: FactoryEvent[];
  scroll: LogScrollState;
  height: number;
}

export function LogTab({ events, scroll, height }: LogTabProps): JSX.Element {
  const { slice, first, last } = visibleSlice(events, scroll, height);

  return (
    <Box flexDirection="column">
      <EventFeed events={slice} />
      <Text dimColor>
        follow: {scroll.follow ? 'on' : 'off'} · ↑/↓ PgUp/PgDn scroll · f follow · {first}-{last}/{events.length}
      </Text>
    </Box>
  );
}
