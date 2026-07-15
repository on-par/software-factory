import type { FactoryEvent } from '@on-par/factory-core';
import { initialState, reduceEvent, type PhaseName, type RunState } from './state.js';

export type LaneStatus = 'running' | 'waiting-merge' | 'ready' | 'merged' | 'failed' | 'stopped';

export interface LaneState {
  issue: string;
  title?: string;
  run: RunState;
  status: LaneStatus;
  failedPhase?: PhaseName;
  failReason?: string;
  prNumber?: string;
  startedAt: string;
  finishedAt?: string;
  waitingSince?: string;
}

export interface DashboardState {
  lanes: LaneState[];
  usageStop?: string;
  runDone: boolean;
}

export function initialDashboard(): DashboardState {
  return { lanes: [], runDone: false };
}

export function isLaneEvent(e: FactoryEvent): boolean {
  return /^\d+$/.test(e.issue);
}

const PHASE_EVENT_TYPES = new Set(['plan', 'build', 'check', 'rework', 'ship']);
const FAILURE_TYPES = new Set(['fail', 'escalate', 'timeout', 'conflict', 'parked', 'ship_denied']);

function newLane(e: FactoryEvent): LaneState {
  return { issue: e.issue, run: initialState(), status: 'running', startedAt: e.ts };
}

export function reduceDashboard(state: DashboardState, e: FactoryEvent): DashboardState {
  if (!isLaneEvent(e)) {
    if (e.type === 'usage-stop') return { ...state, usageStop: e.msg };
    if (e.type === 'run-done') return { ...state, runDone: true };
    return state;
  }

  const idx = state.lanes.findIndex(l => l.issue === e.issue);
  const prevLane = idx === -1 ? newLane(e) : state.lanes[idx];
  const prevStatus = prevLane.status;

  let lane: LaneState = { ...prevLane, run: reduceEvent(prevLane.run, e) };

  if (PHASE_EVENT_TYPES.has(e.type) && prevStatus !== 'running') {
    lane = {
      ...lane,
      status: 'running',
      finishedAt: undefined,
      failedPhase: undefined,
      failReason: undefined,
      waitingSince: undefined,
    };
  } else if (e.type === 'issue-title') {
    lane = { ...lane, title: e.msg };
  } else if (e.type === 'ready') {
    lane = { ...lane, status: 'ready', prNumber: e.msg.match(/PR #(\d+)/)?.[1] ?? lane.prNumber };
  } else if (e.type === 'await-merge') {
    lane = { ...lane, status: 'waiting-merge', waitingSince: lane.waitingSince ?? e.ts };
  } else if (e.type === 'landed') {
    lane = { ...lane, status: 'merged', finishedAt: e.ts };
  } else if (FAILURE_TYPES.has(e.type)) {
    lane = {
      ...lane,
      status: 'failed',
      failedPhase: lane.failedPhase ?? lane.run.activePhase,
      failReason: lane.failReason ?? e.msg,
      finishedAt: e.ts,
    };
  } else if (e.type === 'stopped') {
    lane = { ...lane, status: 'stopped', finishedAt: e.ts };
  }

  const lanes = idx === -1 ? [...state.lanes, lane] : state.lanes.map((l, i) => (i === idx ? lane : l));
  return { ...state, lanes };
}

export function mergeTrainPosition(state: DashboardState, issue: string): number | undefined {
  const waiting = state.lanes
    .filter(l => l.status === 'waiting-merge')
    .sort((a, b) => {
      const diff = Date.parse(a.waitingSince ?? '') - Date.parse(b.waitingSince ?? '');
      return diff !== 0 ? diff : Number(a.issue) - Number(b.issue);
    });
  const idx = waiting.findIndex(l => l.issue === issue);
  return idx === -1 ? undefined : idx + 1;
}

export function laneElapsedMs(lane: LaneState, now: number): number {
  const end = lane.finishedAt ? Date.parse(lane.finishedAt) : now;
  return Math.max(0, end - Date.parse(lane.startedAt));
}
