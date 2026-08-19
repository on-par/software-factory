import {
  LANE_LIFECYCLE_PHASES,
  type LaneLifecycleEvent,
  type LaneLifecyclePhase,
  type LaneLifecycleStatus,
} from '@on-par/contracts';

export const BOARD_PHASES = LANE_LIFECYCLE_PHASES;

export const LOG_TAIL_LIMIT = 8;

export type PhaseSegmentState = 'pending' | 'active' | 'done' | 'failed';

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
  segments: Record<LaneLifecyclePhase, PhaseSegmentState>;
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

function emptySegments(): Record<LaneLifecyclePhase, PhaseSegmentState> {
  return { plan: 'pending', build: 'pending', check: 'pending', ship: 'pending' };
}

export function reduceLaneEvent(state: LaneBoardState, event: LaneLifecycleEvent): LaneBoardState {
  const existing = state.lanes.find((lane) => lane.laneId === event.laneId);
  const previousSegments = existing?.segments ?? emptySegments();
  const previousLog = existing?.log ?? [];

  const nextCard: LaneCard = {
    laneId: event.laneId,
    issueId: event.issueId,
    worktreePath: event.worktreePath,
    phase: event.phase,
    status: event.status,
    detail: event.detail,
    updatedAt: event.ts,
    segments: { ...previousSegments, [event.phase]: SEGMENT_BY_STATUS[event.status] },
    log: [...previousLog, formatLogLine(event)].slice(-LOG_TAIL_LIMIT),
  };

  if (existing) {
    return { lanes: state.lanes.map((lane) => (lane.laneId === event.laneId ? nextCard : lane)) };
  }

  return { lanes: [...state.lanes, nextCard] };
}

export function laneStatusChip(card: LaneCard): { label: string; className: string } {
  if (card.status === 'failed') return { label: 'failed', className: 'bg-status-failed text-white' };
  if (card.status === 'done' && card.phase === 'ship') {
    return { label: 'shipped', className: 'bg-status-shipped text-white' };
  }
  if (card.status === 'done') {
    return { label: `${card.phase} done`, className: 'bg-status-checking text-navy-950' };
  }
  return { label: `${card.phase}…`, className: 'bg-status-building text-navy-950' };
}
