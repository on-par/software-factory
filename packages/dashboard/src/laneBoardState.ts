import type { LaneLifecycleEvent, LaneLifecyclePhase, LaneLifecycleStatus } from '@on-par/factory-core';

export const BOARD_PHASES = ['plan', 'build', 'check', 'ship'] as const satisfies readonly LaneLifecyclePhase[];

export const LOG_TAIL_LIMIT = 20;

export type PhaseSegmentState = 'pending' | 'active' | 'done' | 'failed';

export interface LaneLogLine {
  ts: string;
  phase: LaneLifecyclePhase;
  status: LaneLifecycleStatus;
  detail: string;
}

export interface LaneCard {
  laneId: string;
  issueId: string;
  worktreePath: string;
  phase: LaneLifecyclePhase;
  status: LaneLifecycleStatus;
  detail: string;
  updatedAt: string;
  segments: Record<LaneLifecyclePhase, PhaseSegmentState>;
  log: LaneLogLine[];
}

export interface LaneBoardState {
  lanes: LaneCard[];
}

const SEGMENT_BY_STATUS: Record<LaneLifecycleStatus, PhaseSegmentState> = {
  started: 'active',
  progress: 'active',
  done: 'done',
  failed: 'failed',
};

const CHIP_VERB_BY_STATUS: Record<LaneLifecycleStatus, string> = {
  started: 'running',
  progress: 'running',
  done: 'done',
  failed: 'failed',
};

export function emptyLaneBoard(): LaneBoardState {
  return { lanes: [] };
}

function emptySegments(): Record<LaneLifecyclePhase, PhaseSegmentState> {
  return { plan: 'pending', build: 'pending', check: 'pending', ship: 'pending' };
}

export function reduceLaneEvent(state: LaneBoardState, event: LaneLifecycleEvent): LaneBoardState {
  const existing = state.lanes.find((lane) => lane.laneId === event.laneId);
  const base = existing ?? {
    laneId: event.laneId,
    issueId: event.issueId,
    worktreePath: event.worktreePath,
    phase: event.phase,
    status: event.status,
    detail: event.detail,
    updatedAt: event.ts,
    segments: emptySegments(),
    log: [],
  };

  const nextCard: LaneCard = {
    ...base,
    issueId: event.issueId,
    worktreePath: event.worktreePath,
    phase: event.phase,
    status: event.status,
    detail: event.detail,
    updatedAt: event.ts,
    segments: { ...base.segments, [event.phase]: SEGMENT_BY_STATUS[event.status] },
    log: [...base.log, { ts: event.ts, phase: event.phase, status: event.status, detail: event.detail }].slice(
      -LOG_TAIL_LIMIT,
    ),
  };

  if (existing) {
    return { lanes: state.lanes.map((lane) => (lane.laneId === event.laneId ? nextCard : lane)) };
  }

  return { lanes: [...state.lanes, nextCard].sort((a, b) => a.laneId.localeCompare(b.laneId)) };
}

export function laneChipLabel(card: LaneCard): string {
  return `${card.phase.toUpperCase()} · ${CHIP_VERB_BY_STATUS[card.status]}`;
}
