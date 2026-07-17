import { Text } from 'ink';
import type { JSX } from 'react';

export interface HeaderProps {
  issue?: string;
  repo?: string;
  done: boolean;
}

export function Header({ issue, repo, done }: HeaderProps): JSX.Element {
  const text =
    repo && issue
      ? `Factory — issue #${issue} · ${repo}`
      : issue
        ? `Factory — issue #${issue}`
        : repo
          ? `Factory — ${repo}`
          : 'Factory';

  return (
    <Text bold color="cyan">
      {text}
      {done ? ' (ready)' : ''}
    </Text>
  );
}
