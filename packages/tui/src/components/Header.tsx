import { Text } from 'ink';
import type { JSX } from 'react';

export interface HeaderProps {
  issue?: string;
  title?: string;
  repo?: string;
  done: boolean;
}

export function Header({ issue, title, repo, done }: HeaderProps): JSX.Element {
  const issuePart = issue ? `issue #${issue}${title ? ` ${title}` : ''}` : undefined;
  const text =
    repo && issuePart
      ? `Factory — ${issuePart} · ${repo}`
      : issuePart
        ? `Factory — ${issuePart}`
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
