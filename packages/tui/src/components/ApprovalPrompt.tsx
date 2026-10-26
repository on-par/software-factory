import type { ApprovalRequest } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { sanitizeTerminalText } from '../text.js';

const MAX_DIFF_LINES = 10;

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  pendingCount: number;
  denyReason?: string;
}

export function ApprovalPrompt({ request, pendingCount, denyReason }: ApprovalPromptProps): JSX.Element {
  const diffLines = request.diffStat
    .split('\n')
    .map((l) => sanitizeTerminalText(l))
    .filter(Boolean);
  const truncated = diffLines.length > MAX_DIFF_LINES;
  const visibleDiff = truncated ? diffLines.slice(0, MAX_DIFF_LINES) : diffLines;
  const summary = request.checkSummary;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {`⏸ APPROVAL REQUIRED — issue #${request.issue} (${sanitizeTerminalText(request.branch)})`}
        {pendingCount > 1 ? ` [1 of ${pendingCount}]` : ''}
      </Text>
      {visibleDiff.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
      {truncated && <Text dimColor>… (truncated)</Text>}
      {summary && (
        <Text dimColor>{`checks: ${summary.passes} pass, ${summary.failures} fail, ${summary.skips} skip`}</Text>
      )}
      {denyReason === undefined ? (
        <Text>y approve · n deny</Text>
      ) : (
        <Text>{`deny reason (Enter submit, Esc cancel): ${sanitizeTerminalText(denyReason)}█`}</Text>
      )}
    </Box>
  );
}
