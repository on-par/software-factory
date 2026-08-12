// src/events/kinds.ts — Closed vocabulary for FactoryEvent.type (#663)
//
// FactoryEvent.type used to be a free-form string, classified independently by
// six hand-maintained sets scattered across format.ts, tui/dashboard.ts,
// tui/state.ts, kpis/human.ts, kpis/index.ts, and cli's ParkReason — with no
// seam forcing a newly-emitted kind to be registered anywhere. This module is
// that seam: EventKind is the closed set of kinds the factory actually emits,
// and EVENT_TRAITS is the single table every consumer reads instead of
// maintaining its own classification.

import type { LogLevel } from '../types/index.js';

export type EventKind =
  | 'adr_commit_skipped'
  | 'adr_context'
  | 'adr_context_empty'
  | 'adr_draft_rejected'
  | 'adr_draft_skipped'
  | 'adr_drafts'
  | 'adr_index_skipped'
  | 'adr_read_degraded'
  | 'adr_skipped'
  | 'adr_written'
  | 'approval_granted'
  | 'approval_requested'
  | 'await-merge'
  | 'awaiting-review'
  | 'benchmark-artifacts'
  | 'benchmark-artifacts-failed'
  | 'budget_exceeded'
  | 'build'
  | 'check'
  | 'ci-failed'
  | 'conflict'
  | 'constitution'
  | 'defect-window-closed'
  | 'design_artifact_emitted'
  | 'design_artifact_invalid'
  | 'design_artifact_received'
  | 'design_open_questions'
  | 'design_shallow'
  | 'environment_cleanup'
  | 'environment_conflict'
  | 'environment_lease'
  | 'environment_lease_failed'
  | 'environment_lease_reaped'
  | 'environment_orphan'
  | 'environment_proxy'
  | 'environment_proxy_unavailable'
  | 'environment_release'
  | 'environment_release_failed'
  | 'environment_warning'
  | 'escalate'
  | 'evidence'
  | 'fail'
  | 'failover'
  | 'fast_path'
  | 'human-abandoned'
  | 'human-approved'
  | 'human-edited'
  | 'human-merged'
  | 'human-restarted'
  | 'idle'
  | 'ingested'
  | 'issue-title'
  | 'kpi-snapshot'
  | 'land'
  | 'landed'
  | 'lane-done'
  | 'lane-start'
  | 'local-only'
  | 'local-only-complete'
  | 'lock-stolen'
  | 'merge-gated'
  | 'merged'
  | 'model-override'
  | 'overnight-fail'
  | 'overnight-park'
  | 'overnight-preflight'
  | 'overnight-ready'
  | 'parked'
  | 'plan'
  | 'plan_approval_granted'
  | 'plan_approval_requested'
  | 'plan_redirect'
  | 'plan_rejected'
  | 'post-merge-defect'
  | 'provider_breaker_close'
  | 'provider_breaker_open'
  | 'provider_breaker_skip'
  | 'readiness'
  | 'readiness_enrichment_failed'
  | 'readiness_enrichment_started'
  | 'readiness_enrichment_succeeded'
  | 'ready'
  | 'recovered'
  | 'resource_limit'
  | 'resume-approved'
  | 'resumed'
  | 'rework'
  | 'router'
  | 'run_lock_conflict'
  | 'run-done'
  | 'sandbox'
  | 'sandbox-degraded'
  | 'sandbox-disabled'
  | 'sandbox-unavailable'
  | 'sandbox_violation'
  | 'ship'
  | 'ship_denied'
  | 'skip-ci'
  | 'steering_applied'
  | 'steering_unconsumed'
  | 'stopped'
  | 'stuck'
  | 'supervisor-done'
  | 'timeout'
  | 'triage'
  | 'triage_accepted'
  | 'usage-stop'
  | 'usage-unavailable'
  | 'warn'
  | 'watchdog'
  | 'work-source'
  | 'work_request'
  | 'worker_failover'
  | 'workspace'
  | 'worktree'
  | 'worktree-gc';

/** Lane state an event kind drives in the TUI/queue dashboard reducers; absent
 *  when the kind doesn't itself change lane status. */
export type LaneStatus = 'running' | 'waiting-merge' | 'ready' | 'merged' | 'failed' | 'stopped';

/** `severity` is widened to `'unknown'` only on the sentinel `UNKNOWN_EVENT_TRAITS`
 *  returned by `eventTraitsFor` for a string outside `EventKind` — every real
 *  `EVENT_TRAITS` entry uses a genuine `LogLevel`. */
export interface EventTraits {
  severity: LogLevel | 'unknown';
  /** Counts toward human-intervention KPIs (a lane that needs a human to look at it). */
  isPark: boolean;
  /** Ends the run/lane's current attempt (success or failure). */
  isTerminal: boolean;
  laneStatus?: LaneStatus;
}

/** Every existing `EventKind`, classified once. New kinds must be added here —
 *  omitting one is a compile error, which is the point (#663). */
export const EVENT_TRAITS: Record<EventKind, EventTraits> = {
  adr_commit_skipped: { severity: 'info', isPark: false, isTerminal: false },
  adr_context: { severity: 'info', isPark: false, isTerminal: false },
  adr_context_empty: { severity: 'info', isPark: false, isTerminal: false },
  adr_draft_rejected: { severity: 'info', isPark: false, isTerminal: false },
  adr_draft_skipped: { severity: 'info', isPark: false, isTerminal: false },
  adr_drafts: { severity: 'info', isPark: false, isTerminal: false },
  adr_index_skipped: { severity: 'info', isPark: false, isTerminal: false },
  adr_read_degraded: { severity: 'info', isPark: false, isTerminal: false },
  adr_skipped: { severity: 'info', isPark: false, isTerminal: false },
  adr_written: { severity: 'info', isPark: false, isTerminal: false },
  approval_granted: { severity: 'info', isPark: false, isTerminal: false },
  approval_requested: { severity: 'warn', isPark: false, isTerminal: false },
  'await-merge': { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'waiting-merge' },
  'awaiting-review': { severity: 'info', isPark: false, isTerminal: false },
  'benchmark-artifacts': { severity: 'info', isPark: false, isTerminal: false },
  'benchmark-artifacts-failed': { severity: 'info', isPark: false, isTerminal: false },
  budget_exceeded: { severity: 'warn', isPark: false, isTerminal: false },
  build: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  check: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  'ci-failed': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  conflict: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  constitution: { severity: 'info', isPark: false, isTerminal: false },
  'defect-window-closed': { severity: 'info', isPark: false, isTerminal: false },
  design_artifact_emitted: { severity: 'info', isPark: false, isTerminal: false },
  design_artifact_invalid: { severity: 'warn', isPark: false, isTerminal: false },
  design_artifact_received: { severity: 'info', isPark: false, isTerminal: false },
  design_open_questions: { severity: 'warn', isPark: false, isTerminal: false },
  design_shallow: { severity: 'info', isPark: false, isTerminal: false },
  environment_cleanup: { severity: 'info', isPark: false, isTerminal: false },
  environment_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  environment_lease: { severity: 'info', isPark: false, isTerminal: false },
  environment_lease_failed: { severity: 'info', isPark: false, isTerminal: false },
  environment_lease_reaped: { severity: 'info', isPark: false, isTerminal: false },
  environment_orphan: { severity: 'warn', isPark: false, isTerminal: false },
  environment_proxy: { severity: 'info', isPark: false, isTerminal: false },
  environment_proxy_unavailable: { severity: 'info', isPark: false, isTerminal: false },
  environment_release: { severity: 'info', isPark: false, isTerminal: false },
  environment_release_failed: { severity: 'info', isPark: false, isTerminal: false },
  environment_warning: { severity: 'warn', isPark: false, isTerminal: false },
  escalate: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  evidence: { severity: 'info', isPark: false, isTerminal: false },
  fail: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  failover: { severity: 'info', isPark: false, isTerminal: false },
  fast_path: { severity: 'info', isPark: false, isTerminal: false },
  'human-abandoned': { severity: 'info', isPark: false, isTerminal: true },
  'human-approved': { severity: 'info', isPark: false, isTerminal: false },
  'human-edited': { severity: 'info', isPark: false, isTerminal: false },
  'human-merged': { severity: 'info', isPark: false, isTerminal: true },
  'human-restarted': { severity: 'info', isPark: false, isTerminal: false },
  idle: { severity: 'info', isPark: false, isTerminal: false },
  ingested: { severity: 'info', isPark: false, isTerminal: false },
  'issue-title': { severity: 'info', isPark: false, isTerminal: false },
  'kpi-snapshot': { severity: 'info', isPark: false, isTerminal: false },
  land: { severity: 'info', isPark: false, isTerminal: false },
  landed: { severity: 'info', isPark: false, isTerminal: true, laneStatus: 'merged' },
  'lane-done': { severity: 'info', isPark: false, isTerminal: false },
  'lane-start': { severity: 'info', isPark: false, isTerminal: false },
  'local-only': { severity: 'info', isPark: false, isTerminal: false },
  'local-only-complete': { severity: 'info', isPark: false, isTerminal: false },
  'lock-stolen': { severity: 'info', isPark: false, isTerminal: false },
  'merge-gated': { severity: 'info', isPark: false, isTerminal: false },
  merged: { severity: 'info', isPark: false, isTerminal: true },
  'model-override': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-fail': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-park': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-preflight': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-ready': { severity: 'info', isPark: false, isTerminal: false },
  parked: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  plan: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  plan_approval_granted: { severity: 'info', isPark: false, isTerminal: false },
  plan_approval_requested: { severity: 'info', isPark: false, isTerminal: false },
  plan_redirect: { severity: 'info', isPark: false, isTerminal: false },
  plan_rejected: { severity: 'info', isPark: false, isTerminal: false },
  'post-merge-defect': { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_close: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_open: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_skip: { severity: 'info', isPark: false, isTerminal: false },
  readiness: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_failed: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_started: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_succeeded: { severity: 'info', isPark: false, isTerminal: false },
  ready: { severity: 'info', isPark: false, isTerminal: true, laneStatus: 'ready' },
  recovered: { severity: 'info', isPark: false, isTerminal: false },
  resource_limit: { severity: 'warn', isPark: false, isTerminal: false },
  'resume-approved': { severity: 'info', isPark: false, isTerminal: false },
  resumed: { severity: 'info', isPark: false, isTerminal: false },
  rework: { severity: 'warn', isPark: false, isTerminal: false, laneStatus: 'running' },
  router: { severity: 'info', isPark: false, isTerminal: false },
  run_lock_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  'run-done': { severity: 'info', isPark: false, isTerminal: true },
  sandbox: { severity: 'info', isPark: false, isTerminal: false },
  'sandbox-degraded': { severity: 'warn', isPark: false, isTerminal: false },
  'sandbox-disabled': { severity: 'warn', isPark: false, isTerminal: false },
  'sandbox-unavailable': { severity: 'warn', isPark: false, isTerminal: false },
  sandbox_violation: { severity: 'warn', isPark: false, isTerminal: false },
  ship: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  ship_denied: { severity: 'error', isPark: false, isTerminal: true, laneStatus: 'failed' },
  'skip-ci': { severity: 'info', isPark: false, isTerminal: false },
  steering_applied: { severity: 'info', isPark: false, isTerminal: false },
  steering_unconsumed: { severity: 'info', isPark: false, isTerminal: false },
  stopped: { severity: 'warn', isPark: false, isTerminal: true, laneStatus: 'stopped' },
  stuck: { severity: 'warn', isPark: true, isTerminal: false },
  'supervisor-done': { severity: 'info', isPark: false, isTerminal: false },
  timeout: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  triage: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  triage_accepted: { severity: 'info', isPark: false, isTerminal: false },
  'usage-stop': { severity: 'info', isPark: false, isTerminal: false },
  'usage-unavailable': { severity: 'info', isPark: false, isTerminal: false },
  warn: { severity: 'warn', isPark: false, isTerminal: false },
  watchdog: { severity: 'info', isPark: false, isTerminal: false },
  'work-source': { severity: 'info', isPark: false, isTerminal: false },
  work_request: { severity: 'info', isPark: false, isTerminal: false },
  worker_failover: { severity: 'info', isPark: false, isTerminal: false },
  workspace: { severity: 'info', isPark: false, isTerminal: false },
  worktree: { severity: 'info', isPark: false, isTerminal: false },
  'worktree-gc': { severity: 'info', isPark: false, isTerminal: false },
};

/** Returned by `eventTraitsFor` for a string outside `EventKind` (e.g. a kind
 *  logged by an older factory version whose vocabulary has since narrowed).
 *  Deliberately not `{ severity: 'info', ... }` — an unrecognized kind must
 *  never silently read as routine/successful. */
export const UNKNOWN_EVENT_TRAITS: EventTraits = { severity: 'unknown', isPark: false, isTerminal: false };

function isEventKind(type: string): type is EventKind {
  return Object.hasOwn(EVENT_TRAITS, type);
}

/** Classifies any string read off a `FactoryEvent.type` — including one from an
 *  older NDJSON file the current `EventKind` union no longer covers, in which
 *  case it returns `UNKNOWN_EVENT_TRAITS` rather than guessing. */
export function eventTraitsFor(type: string): EventTraits {
  return isEventKind(type) ? EVENT_TRAITS[type] : UNKNOWN_EVENT_TRAITS;
}

/** `LogLevel` for a kind; unknown kinds map to `'info'` (matches the historical
 *  default so unrecognized-but-harmless kinds from old logs don't get flagged). */
export function severityOf(type: string): LogLevel {
  const { severity } = eventTraitsFor(type);
  return severity === 'unknown' ? 'info' : severity;
}

/** Whether this kind counts toward human-intervention/park KPIs. */
export function isParkKind(type: string): boolean {
  return eventTraitsFor(type).isPark;
}

/** Lane status this kind drives in a lane-state reducer, or undefined when the
 *  kind doesn't itself change lane status. */
export function laneStatusOf(type: string): LaneStatus | undefined {
  return eventTraitsFor(type).laneStatus;
}
