// packages/core/src/lifecycle/lifecycle.ts — the one canonical lifecycle for an issue's run.
//
// Before this module the same lifecycle was described by at least six drifting vocabularies:
// `RunStatus` (persisted run record), `RunOutcome.state` (terminal outcome), `FailurePhase`
// (PLAN/BUILD/CHECK/SHIP), `PrRunStatus` (the resumable PR comment), `LaneStatus` (the TUI/queue
// dashboard projection) and `EventKind` + `EVENT_TRAITS` (the 250-kind event log). They disagreed
// at the edges (a lane can be `failed` while its run is `parked`; `LaneStatus` has no paused state).
//
// This module is the single source of truth for the *shape* of the lifecycle: its states, its legal
// edges, which states end an attempt, and which can be requeued. The legacy vocabularies remain as
// lossless projections so callers migrate one at a time with identical output (ADR-0177).
//
// It is additive: nothing in the engine reads it yet. `describeLifecycle()` is the AX surface; the
// projections are the DX surface; `LIFECYCLE_LABELS` is the UX surface.

import type { LaneStatus } from '../events/event-traits.js';
import type { PrRunStatus } from '../run/pr-run-state.js';
import type { RunStatus } from '../types/index.js';

/** Every canonical lifecycle state, in rough order of progress. */
export const LIFECYCLE_STATES = [
  'queued',
  'claimed',
  'planning',
  'building',
  'checking',
  'reworking',
  'shipping',
  'awaiting-ci',
  'awaiting-review',
  'ready',
  'merged',
  'parked',
  'escalated',
  'failed',
  'stopped',
  'paused',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** Human-facing labels, one per state. The TUI, dashboard and `factory status` read this instead of
 *  inventing their own wording for the same condition. */
export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  queued: 'Queued',
  claimed: 'Claimed',
  planning: 'Planning',
  building: 'Building',
  checking: 'Checking',
  reworking: 'Reworking',
  shipping: 'Shipping',
  'awaiting-ci': 'Waiting for CI',
  'awaiting-review': 'Waiting for review',
  ready: 'Ready to merge',
  merged: 'Merged',
  parked: 'Parked',
  escalated: 'Escalated',
  failed: 'Failed',
  stopped: 'Stopped',
  paused: 'Paused',
};

/** States that end the current attempt (success or failure). `parked`, `escalated`, `failed` and
 *  `stopped` can still be requeued; see `RESUMABLE_LIFECYCLE_STATES`. */
export const TERMINAL_LIFECYCLE_STATES = [
  'merged',
  'parked',
  'escalated',
  'failed',
  'stopped',
] as const satisfies readonly LifecycleState[];

/** Attempt-ending states from which the issue can legally return to `queued`. `paused` is not
 *  attempt-ending but is also requeued when the lane resumes. */
export const RESUMABLE_LIFECYCLE_STATES = [
  'parked',
  'escalated',
  'failed',
  'stopped',
  'paused',
] as const satisfies readonly LifecycleState[];

/** States with no outgoing edge at all. */
export const FINAL_LIFECYCLE_STATES = ['merged'] as const satisfies readonly LifecycleState[];

/** Every legal structural edge. Guards (budgets, claims, labels, CI) decide whether an edge is
 *  actually taken; this table only says which edges exist. Adding a state forces an entry here. */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  queued: ['claimed', 'stopped', 'paused'],
  claimed: ['planning', 'parked', 'failed', 'stopped'],
  planning: ['building', 'parked', 'escalated', 'failed', 'stopped'],
  building: ['checking', 'parked', 'escalated', 'failed', 'stopped'],
  checking: ['reworking', 'shipping', 'parked', 'failed', 'stopped'],
  reworking: ['checking', 'parked', 'escalated', 'failed', 'stopped'],
  shipping: ['awaiting-ci', 'awaiting-review', 'ready', 'parked', 'failed', 'stopped'],
  'awaiting-ci': ['ready', 'awaiting-review', 'parked', 'failed', 'stopped'],
  'awaiting-review': ['ready', 'merged', 'parked', 'stopped'],
  ready: ['merged', 'parked', 'stopped'],
  merged: [],
  parked: ['queued'],
  escalated: ['queued'],
  failed: ['queued'],
  stopped: ['queued'],
  paused: ['queued'],
};

const TERMINAL: ReadonlySet<LifecycleState> = new Set(
  LIFECYCLE_STATES.filter((s) => isOneOf(s, TERMINAL_LIFECYCLE_STATES)),
);
const RESUMABLE: ReadonlySet<LifecycleState> = new Set(
  LIFECYCLE_STATES.filter((s) => isOneOf(s, RESUMABLE_LIFECYCLE_STATES)),
);
const FINAL: ReadonlySet<LifecycleState> = new Set(LIFECYCLE_STATES.filter((s) => isOneOf(s, FINAL_LIFECYCLE_STATES)));

function isOneOf(state: LifecycleState, set: readonly LifecycleState[]): boolean {
  return set.includes(state);
}

/** Whether the state ends the current attempt. `paused` does not. */
export function isTerminalLifecycleState(state: LifecycleState): boolean {
  return TERMINAL.has(state);
}

/** Whether the issue can be requeued from this state. */
export function isResumableLifecycleState(state: LifecycleState): boolean {
  return RESUMABLE.has(state);
}

/** Whether the state has no outgoing edge at all. */
export function isFinalLifecycleState(state: LifecycleState): boolean {
  return FINAL.has(state);
}

export function canTransitionLifecycle(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Thrown by `assertLifecycleTransition` for an edge outside `LIFECYCLE_TRANSITIONS`. */
export class LifecycleTransitionError extends Error {
  readonly from: LifecycleState;
  readonly to: LifecycleState;

  constructor(from: LifecycleState, to: LifecycleState) {
    super(`illegal lifecycle transition: ${from} -> ${to}`);
    this.name = 'LifecycleTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Returns `to` when the edge is legal, else throws `LifecycleTransitionError`. */
export function assertLifecycleTransition(from: LifecycleState, to: LifecycleState): LifecycleState {
  if (!canTransitionLifecycle(from, to)) throw new LifecycleTransitionError(from, to);
  return to;
}

// ---------- Lossless projections to the legacy vocabularies ----------

const RUN_STATUS_OF: Record<LifecycleState, RunStatus> = {
  queued: 'pending',
  claimed: 'pending',
  planning: 'planning',
  building: 'building',
  checking: 'checking',
  reworking: 'reworking',
  shipping: 'shipping',
  'awaiting-ci': 'shipping',
  'awaiting-review': 'awaiting-review',
  ready: 'ready',
  merged: 'merged',
  parked: 'parked',
  escalated: 'escalated',
  failed: 'failed',
  stopped: 'pending',
  paused: 'pending',
};

/** The persisted `IssueRunState.status` this state projects to. Lossy only for canonical-only
 *  states (`claimed`, `awaiting-ci`, `stopped`, `paused`), which collapse onto an existing member. */
export function toRunStatus(state: LifecycleState): RunStatus {
  return RUN_STATUS_OF[state];
}

const LIFECYCLE_OF_RUN_STATUS: Record<RunStatus, LifecycleState> = {
  pending: 'queued',
  planning: 'planning',
  building: 'building',
  checking: 'checking',
  reworking: 'reworking',
  shipping: 'shipping',
  ready: 'ready',
  'awaiting-review': 'awaiting-review',
  parked: 'parked',
  escalated: 'escalated',
  merged: 'merged',
  failed: 'failed',
};

/** The canonical state for a persisted `RunStatus`. Round-trips exactly through `toRunStatus`. */
export function fromRunStatus(status: RunStatus): LifecycleState {
  return LIFECYCLE_OF_RUN_STATUS[status];
}

const LIFECYCLE_OF_LANE_STATUS: Record<LaneStatus, LifecycleState> = {
  running: 'building',
  'waiting-merge': 'awaiting-review',
  ready: 'ready',
  merged: 'merged',
  failed: 'failed',
  parked: 'parked',
  stopped: 'stopped',
};

/** The canonical representative of a coarse `LaneStatus`. `running` covers every active phase, so
 *  it maps to `building`; use the event stream for the exact phase. */
export function fromLaneStatus(status: LaneStatus): LifecycleState {
  return LIFECYCLE_OF_LANE_STATUS[status];
}

const LANE_STATUS_OF: Record<LifecycleState, LaneStatus | undefined> = {
  queued: undefined,
  claimed: 'running',
  planning: 'running',
  building: 'running',
  checking: 'running',
  reworking: 'running',
  shipping: 'running',
  'awaiting-ci': 'running',
  'awaiting-review': 'waiting-merge',
  ready: 'ready',
  merged: 'merged',
  parked: 'parked',
  escalated: 'failed',
  failed: 'failed',
  stopped: 'stopped',
  // The legacy LaneStatus has no paused state (#1906 comment in events/kinds.ts). Map to `parked`
  // until the TUI adopts the canonical state directly (ADR-0177).
  paused: 'parked',
};

/** The `LaneStatus` the dashboard reducer uses for this state, or undefined before a lane exists. */
export function laneStatusFromLifecycle(state: LifecycleState): LaneStatus | undefined {
  return LANE_STATUS_OF[state];
}

const PR_RUN_STATUS_OF: Record<LifecycleState, PrRunStatus> = {
  queued: 'building',
  claimed: 'building',
  planning: 'building',
  building: 'building',
  checking: 'building',
  reworking: 'building',
  shipping: 'awaiting-ci',
  'awaiting-ci': 'awaiting-ci',
  'awaiting-review': 'awaiting-review',
  ready: 'awaiting-review',
  merged: 'awaiting-review',
  parked: 'parked',
  escalated: 'parked',
  failed: 'parked',
  stopped: 'parked',
  paused: 'parked',
};

/** The resumable PR-comment status this state projects to (ADR-0174). */
export function prRunStatusFromLifecycle(state: LifecycleState): PrRunStatus {
  return PR_RUN_STATUS_OF[state];
}

// ---------- The machine-readable descriptor (AX) ----------

export interface LifecycleStateDescriptor {
  label: string;
  terminal: boolean;
  resumable: boolean;
  final: boolean;
  runStatus: RunStatus;
  laneStatus?: LaneStatus;
  prRunStatus: PrRunStatus;
  next: readonly LifecycleState[];
}

export interface LifecycleDescriptor {
  version: 1;
  states: Record<LifecycleState, LifecycleStateDescriptor>;
}

function describeLifecycleState(state: LifecycleState): LifecycleStateDescriptor {
  const laneStatus = LANE_STATUS_OF[state];
  return {
    label: LIFECYCLE_LABELS[state],
    terminal: TERMINAL.has(state),
    resumable: RESUMABLE.has(state),
    final: FINAL.has(state),
    runStatus: RUN_STATUS_OF[state],
    ...(laneStatus === undefined ? {} : { laneStatus }),
    prRunStatus: PR_RUN_STATUS_OF[state],
    next: LIFECYCLE_TRANSITIONS[state],
  };
}

/** The full lifecycle as plain JSON: every state, its flags, every projection and every edge.
 *  Agents and docs read this instead of reverse-engineering the event log and label set. */
export function describeLifecycle(): LifecycleDescriptor {
  return {
    version: 1,
    states: {
      queued: describeLifecycleState('queued'),
      claimed: describeLifecycleState('claimed'),
      planning: describeLifecycleState('planning'),
      building: describeLifecycleState('building'),
      checking: describeLifecycleState('checking'),
      reworking: describeLifecycleState('reworking'),
      shipping: describeLifecycleState('shipping'),
      'awaiting-ci': describeLifecycleState('awaiting-ci'),
      'awaiting-review': describeLifecycleState('awaiting-review'),
      ready: describeLifecycleState('ready'),
      merged: describeLifecycleState('merged'),
      parked: describeLifecycleState('parked'),
      escalated: describeLifecycleState('escalated'),
      failed: describeLifecycleState('failed'),
      stopped: describeLifecycleState('stopped'),
      paused: describeLifecycleState('paused'),
    },
  };
}
