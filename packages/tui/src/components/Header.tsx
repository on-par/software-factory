import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { formatAgo } from '../dashboard.js';
import { sanitizeTerminalText } from '../text.js';
import { formatDuration } from './PhaseRow.js';

export interface HeaderProps {
  issue?: string;
  repo?: string;
  done: boolean;
  title?: string;
  phase?: string;
  elapsedMs?: number;
  lastActivityAt?: string;
  now?: number;
}

export function Header({ issue, repo, done, title, phase, elapsedMs, lastActivityAt, now }: HeaderProps): JSX.Element {
  const text =
    repo && issue
      ? `Factory — issue #${issue} · ${repo}`
      : issue
        ? `Factory — issue #${issue}`
        : repo
          ? `Factory — ${repo}`
          : 'Factory';

  const first = (
    <Text bold color="cyan">
      {text}
      {done ? ' (ready)' : ''}
    </Text>
  );
  if (title === undefined && elapsedMs === undefined && lastActivityAt === undefined) return first;

  const parts: string[] = [];
  if (title) parts.push(sanitizeTerminalText(title));
  parts.push(phase ?? (done ? 'done' : 'waiting'));
  if (elapsedMs !== undefined) parts.push(`elapsed ${formatDuration(elapsedMs)}`);
  if (lastActivityAt) parts.push(`last activity ${formatAgo(lastActivityAt, now ?? Date.now())}`);

  return (
    <Box flexDirection="column">
      {first}
      <Text>{parts.join(' · ')}</Text>
    </Box>
  );
}
