import { laneStatusOf, type FactoryEvent, type FailoverReason } from '@on-par/factory-core';

import { initialState, type PhaseName, reduceEvent, type RunState } from './state.js';

export type LaneStatus = 'running' | 'waiting-merge' | 'ready' | 'merged' | 'failed' | 'parked' | 'stopped';

export interface LaneFailureEvidence {
  reason: FailoverReason;
  fingerprint: string;
}

export interface LaneState {
  issue: string;
  title?: string;
  run: RunState;
  status: LaneStatus;
  failedPhase?: PhaseName;
  failReason?: string;
  failureEvidence?: LaneFailureEvidence;
  prNumber?: string;
  startedAt: string;
  finishedAt?: string;
  waitingSince?: string;
  worktree?: string;
  /** Timestamp of the lane's most recent event; the staleness input for partitionLanesByActivity (#1369). */
  lastEventAt: string;
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

function newLane(e: FactoryEvent): LaneState {
  return { issue: e.issue, run: initialState(), status: 'running', startedAt: e.ts, lastEventAt: e.ts };
}

/** Lane statuses that mean "this lane is still doing something"; only these can go stale. */
const NON_TERMINAL: ReadonlySet<LaneStatus> = new Set(['running', 'ready', 'waiting-merge']);

/** True for lanes whose staleness depends on a heartbeat — the only ones worth polling a snapshot for. */
export function isNonTerminalLane(lane: LaneState): boolean {
  return NON_TERMINAL.has(lane.status);
}

export function reduceDashboard(state: DashboardState, e: FactoryEvent): DashboardState {
  if (!isLaneEvent(e)) {
    if (e.type === 'usage-stop') return { ...state, usageStop: e.msg };
    // A finished run has no active lanes by definition: drop them, so replaying a log that
    // holds many runs leaves only the run in progress on the Active tab (#1369).
    if (e.type === 'run-done') return { ...state, lanes: [], runDone: true };
    return state;
  }

  // After a run ended, only a run's own opening events (`issue-title`, a phase start) may open
  // the next run's lane set. Out-of-run commands log numeric-issue events too — `factory land`
  // logs `land` / `merged` / `fail` — and those must not resurrect a phantom lane (#1369).
  if (state.runDone && !(e.type === 'issue-title' || laneStatusOf(e.type) === 'running')) return state;
  const base = state.runDone ? { ...state, lanes: [], runDone: false, usageStop: undefined } : state;
  const idx = base.lanes.findIndex((l) => l.issue === e.issue);
  const prevLane = idx === -1 ? newLane(e) : base.lanes[idx];
  const prevStatus = prevLane.status;

  let lane: LaneState = { ...prevLane, run: reduceEvent(prevLane.run, e), lastEventAt: e.ts };

  if (laneStatusOf(e.type) === 'running' && prevStatus !== 'running') {
    lane = {
      ...lane,
      status: 'running',
      finishedAt: undefined,
      failedPhase: undefined,
      failReason: undefined,
      failureEvidence: undefined,
      waitingSince: undefined,
    };
  } else if (e.type === 'issue-title') {
    lane = { ...lane, title: e.msg };
  } else if (e.type === 'worktree') {
    const prefix = 'Worktree ready at ';
    lane = { ...lane, worktree: e.msg.startsWith(prefix) ? e.msg.slice(prefix.length) : lane.worktree };
  } else if (e.type === 'ready') {
    lane = { ...lane, status: 'ready', prNumber: e.msg.match(/PR #(\d+)/)?.[1] ?? lane.prNumber };
  } else if (e.type === 'await-merge') {
    lane = { ...lane, status: 'waiting-merge', waitingSince: lane.waitingSince ?? e.ts };
  } else if (e.type === 'landed' || e.type === 'merged') {
    lane = { ...lane, status: 'merged', finishedAt: e.ts };
  } else if (laneStatusOf(e.type) === 'failed' || laneStatusOf(e.type) === 'parked') {
    const capturedEvidence =
      e.evidence && e.fingerprint ? { reason: e.evidence.reason, fingerprint: e.fingerprint } : undefined;
    lane = {
      ...lane,
      status: laneStatusOf(e.type) as 'failed' | 'parked',
      failedPhase: lane.failedPhase ?? lane.run.activePhase,
      failReason: lane.failReason ?? e.msg,
      failureEvidence: lane.failureEvidence ?? capturedEvidence,
      finishedAt: e.ts,
    };
  } else if (e.type === 'stopped') {
    lane = { ...lane, status: 'stopped', finishedAt: e.ts };
  }

  const lanes = idx === -1 ? [...base.lanes, lane] : base.lanes.map((l, i) => (i === idx ? lane : l));
  return { ...base, lanes };
}

export interface LaneActivityPartition {
  /** Lanes to show: every terminal lane of the current run, plus non-terminal lanes with recent activity. */
  active: LaneState[];
  /** Non-terminal lanes with neither a recent event nor a recent phase-snapshot heartbeat. */
  staleCount: number;
}

/** Hides lanes a dead or killed run left behind at `running` / `ready` / `waiting-merge` (#1369).
 *  A lane stays visible while either its last event or its per-issue phase-snapshot heartbeat
 *  (`RunPhaseSnapshot.lastActivityAt`, keyed by issue in `heartbeats`) is within the threshold —
 *  the same rule `factory status` applies to local claims (ADR-0086). Terminal lanes are never
 *  hidden; `run-done` clears them. */
export function partitionLanesByActivity(
  lanes: readonly LaneState[],
  opts: { now: number; heartbeats?: Readonly<Record<string, string | undefined>>; staleThresholdMs: number },
): LaneActivityPartition {
  const fresh = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const age = opts.now - Date.parse(iso);
    return Number.isFinite(age) && age <= opts.staleThresholdMs;
  };
  const active: LaneState[] = [];
  let staleCount = 0;
  for (const lane of lanes) {
    if (!NON_TERMINAL.has(lane.status) || fresh(lane.lastEventAt) || fresh(opts.heartbeats?.[lane.issue])) {
      active.push(lane);
    } else {
      staleCount += 1;
    }
  }
  return { active, staleCount };
}

export function mergeTrainPosition(state: DashboardState, issue: string): number | undefined {
  const waiting = state.lanes
    .filter((l) => l.status === 'waiting-merge')
    .sort((a, b) => {
      const diff = Date.parse(a.waitingSince ?? '') - Date.parse(b.waitingSince ?? '');
      return diff !== 0 ? diff : Number(a.issue) - Number(b.issue);
    });
  const idx = waiting.findIndex((l) => l.issue === issue);
  return idx === -1 ? undefined : idx + 1;
}

export function laneElapsedMs(lane: LaneState, now: number): number {
  const end = lane.finishedAt ? Date.parse(lane.finishedAt) : now;
  return Math.max(0, end - Date.parse(lane.startedAt));
}
