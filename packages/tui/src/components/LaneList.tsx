import { Box, Text } from 'ink';
import type { JSX } from 'react';

import {
  type DashboardState,
  isNonTerminalLane,
  type LaneGroup,
  type LaneState,
  mergeTrainPosition,
} from '../dashboard.js';
import { sanitizeTerminalText } from '../text.js';
import { phaseLabel, StatusCell } from './LaneRow.js';
import { formatDuration, spinnerFrame } from './PhaseRow.js';

export interface LaneSummary {
  lane: string;
  current: LaneState;
  merged: number;
  running: number;
  waiting: number;
  failed: number;
  total: number;
  ageMs: number;
}

export function summarizeLane(group: LaneGroup, now: number): LaneSummary {
  const { issues } = group;
  const current = [...issues].reverse().find(isNonTerminalLane) ?? issues[issues.length - 1];
  const count = (...statuses: string[]) => issues.filter((i) => statuses.includes(i.status)).length;
  const earliest = Math.min(...issues.map((i) => Date.parse(i.startedAt)));
  return {
    lane: group.lane,
    current,
    merged: count('merged'),
    running: count('running'),
    waiting: count('waiting-merge', 'ready'),
    failed: count('failed', 'parked'),
    total: issues.length,
    ageMs: Number.isFinite(earliest) ? Math.max(0, now - earliest) : 0,
  };
}

export interface LaneListProps {
  groups: LaneGroup[];
  selectedIndex: number;
  now: number;
  state: DashboardState;
}

function NowCell({ current, now, state }: { current: LaneState; now: number; state: DashboardState }): JSX.Element {
  const pos = mergeTrainPosition(state, current.issue);
  if (current.status === 'running') {
    return (
      <Text>
        <Text color="yellow">{spinnerFrame(now)}</Text>{' '}
        {phaseLabel(current.run.activePhase ?? '?', current.reworkRound)}
      </Text>
    );
  }
  if (current.status === 'waiting-merge') {
    return <Text color="yellow">⏳ merge{pos !== undefined ? ` #${pos} in train` : ''}</Text>;
  }
  return <StatusCell lane={current} now={now} trainPosition={pos} />;
}

export function LaneList({ groups, selectedIndex, now, state }: LaneListProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{'  LANE     NOW                         PROGRESS   AGE'}</Text>
      {groups.map((group, i) => {
        const s = summarizeLane(group, now);
        const selected = i === selectedIndex;
        const progress = [
          s.merged > 0 && `${s.merged}✔`,
          s.running > 0 && `${s.running}▶`,
          s.waiting > 0 && `${s.waiting}⏳`,
          s.failed > 0 && `${s.failed}✖`,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <Box key={group.lane}>
            <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
            <Text>{sanitizeTerminalText(group.lane).padEnd(8)} </Text>
            <Text bold>#{s.current.issue}</Text>
            <Text> </Text>
            <NowCell current={s.current} now={now} state={state} />
            <Text> {progress} </Text>
            <Text dimColor>{formatDuration(s.ageMs)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
