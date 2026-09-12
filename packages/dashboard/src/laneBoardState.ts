import {
  LANE_LIFECYCLE_PHASES,
  type LaneLifecycleEvent,
  type LaneLifecycleLaneState,
  type LaneLifecyclePhase,
  type LaneLifecycleStatus,
} from '@on-par/contracts';

export const BOARD_PHASES = LANE_LIFECYCLE_PHASES;

export const LOG_TAIL_LIMIT = 8;

export type PhaseSegmentState = 'pending' | 'active' | 'done' | 'failed';

export interface PhaseSegment {
  state: PhaseSegmentState;
  /** ISO ts of the first frame seen for this phase; absent while pending. */
  startedAt?: string;
  /** ISO ts of the frame that finished this phase; absent while pending or active. */
  endedAt?: string;
}

export function formatLogLine(event: Pick<LaneLifecycleEvent, 'ts' | 'phase' | 'status' | 'detail'>): string {
  return `${event.ts.slice(11, 19)} ${event.phase} ${event.status} — ${event.detail}`;
}

export interface LaneCard {
  laneId: string;
  issueId: string;
  worktreePath: string;
  phase: LaneLifecyclePhase;
  status: LaneLifecycleStatus;
  detail: string;
  updatedAt: string;
  startedAt: string;
  laneState?: LaneLifecycleLaneState;
  segments: Record<LaneLifecyclePhase, PhaseSegment>;
  log: string[];
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

export function emptyLaneBoard(): LaneBoardState {
  return { lanes: [] };
}

function emptySegments(): Record<LaneLifecyclePhase, PhaseSegment> {
  return {
    plan: { state: 'pending' },
    build: { state: 'pending' },
    check: { state: 'pending' },
    ship: { state: 'pending' },
  };
}

export function reduceLaneEvent(state: LaneBoardState, event: LaneLifecycleEvent): LaneBoardState {
  const existing = state.lanes.find((lane) => lane.laneId === event.laneId);
  const previousSegments = existing?.segments ?? emptySegments();
  const previousLog = existing?.log ?? [];

  const previousSegment = previousSegments[event.phase];
  const segmentState = SEGMENT_BY_STATUS[event.status];
  const segment: PhaseSegment = {
    state: segmentState,
    startedAt: previousSegment.startedAt ?? event.ts,
    ...(segmentState === 'done' || segmentState === 'failed' ? { endedAt: event.ts } : {}),
  };

  const nextCard: LaneCard = {
    laneId: event.laneId,
    issueId: event.issueId,
    worktreePath: event.worktreePath,
    phase: event.phase,
    status: event.status,
    detail: event.detail,
    updatedAt: event.ts,
    startedAt: existing?.startedAt ?? event.ts,
    laneState: event.laneState ?? (event.status === 'started' ? undefined : existing?.laneState),
    segments: { ...previousSegments, [event.phase]: segment },
    log: [...previousLog, formatLogLine(event)].slice(-LOG_TAIL_LIMIT),
  };

  if (existing) {
    return { lanes: state.lanes.map((lane) => (lane.laneId === event.laneId ? nextCard : lane)) };
  }

  return { lanes: [...state.lanes, nextCard] };
}
