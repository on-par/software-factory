import type { QueueSnapshot } from '@on-par/factory-core';
import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { type DashboardState, type LaneGroup, type LaneState, mergeTrainPosition } from '../dashboard.js';
import { laneQueueRows } from '../lane-queue.js';
import { sanitizeTerminalText } from '../text.js';
import { staleLanesLine } from './Dashboard.js';
import { LaneRow } from './LaneRow.js';
import { summarizeLane } from './LaneList.js';
import { StopBanner } from './StopBanner.js';

const MERGED_COLLAPSE_THRESHOLD = 3;
const TITLE_MAX_LENGTH = 32;

function truncate(s: string, max: number): string {
  const clean = sanitizeTerminalText(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface LaneViewRows {
  rows: LaneState[];
  collapsed?: { count: number; first: string; last: string };
}

export function collapseMerged(issues: LaneState[], expanded: boolean): LaneViewRows {
  const merged = issues.filter((i) => i.status === 'merged');
  if (expanded || merged.length <= MERGED_COLLAPSE_THRESHOLD) return { rows: issues };
  const nums = merged.map((i) => Number(i.issue));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return {
    rows: issues.filter((i) => i.status !== 'merged'),
    collapsed: {
      count: merged.length,
      first: merged.find((i) => Number(i.issue) === lo)!.issue,
      last: merged.find((i) => Number(i.issue) === hi)!.issue,
    },
  };
}

export interface LaneViewProps {
  group: LaneGroup;
  state: DashboardState;
  selectedIndex: number;
  mergedExpanded: boolean;
  now: number;
  canGoBack: boolean;
  stopReason?: string;
  staleCount?: number;
  /** The polled queue; absent when the App has no queue reader. */
  queue?: QueueSnapshot;
}

export function LaneView({
  group,
  state,
  selectedIndex,
  mergedExpanded,
  now,
  canGoBack,
  stopReason,
  staleCount = 0,
  queue,
}: LaneViewProps): JSX.Element {
  const s = summarizeLane(group, now);
  const { rows, collapsed } = collapseMerged(group.issues, mergedExpanded);
  const q = queue !== undefined ? laneQueueRows(group.lane, queue, group.issues) : undefined;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        lane {sanitizeTerminalText(group.lane)} · {s.merged}/{s.total} merged · {s.running} running
      </Text>
      {stopReason && <StopBanner reason={stopReason} />}
      {collapsed && (
        <Box>
          <Text color="green">
            {'  '}✔ {collapsed.count} merged (#{collapsed.first}–#{collapsed.last})
          </Text>
          <Text dimColor> [m expand]</Text>
        </Box>
      )}
      {rows.map((issue, i) => (
        <LaneRow
          key={issue.issue}
          lane={issue}
          selected={i === selectedIndex}
          now={now}
          trainPosition={mergeTrainPosition(state, issue.issue)}
          showReason
        />
      ))}
      {q?.unavailable !== undefined && (
        <Text color="red">
          {'  '}queue unavailable ({sanitizeTerminalText(q.unavailable)})
        </Text>
      )}
      {q?.rows.map((row) => (
        <Box key={`queue-${row.issue}`}>
          <Text>{'  '}</Text>
          {row.kind === 'queued' ? <Text dimColor>queued ({row.position})</Text> : <Text color="yellow">parked</Text>}
          <Text>
            {' '}
            <Text bold>#{row.issue}</Text> {truncate(row.title ?? '', TITLE_MAX_LENGTH)}
          </Text>
        </Box>
      ))}
      {staleCount > 0 && <Text dimColor>{staleLanesLine(staleCount)}</Text>}
      <Text dimColor>{`↑/↓ select · ⏎ issue detail · m merged · ${canGoBack ? 'esc lanes · ' : ''}q quit`}</Text>
    </Box>
  );
}
