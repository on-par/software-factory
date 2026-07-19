import { Box, Text } from 'ink';
import type { JSX } from 'react';

export interface SteeringComposerProps {
  issue: string;
  draft: string;
  missingPaths: string[];
}

export function SteeringComposer({ issue, draft, missingPaths }: SteeringComposerProps): JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{`Steer issue #${issue}`}</Text>
      <Text>{`${draft}▌`}</Text>
      {missingPaths.length > 0 && (
        <Text color="yellow">{`⚠ not found in worktree: ${missingPaths.join(', ')} — Enter again to send anyway`}</Text>
      )}
      <Text dimColor>Enter send · Esc cancel</Text>
    </Box>
  );
}
