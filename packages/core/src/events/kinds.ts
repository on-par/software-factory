// src/events/kinds.ts — Closed vocabulary for FactoryEvent.type (#663)
//
// FactoryEvent.type was free-form, classified by six hand-maintained sets with no seam forcing a
// newly-emitted kind to be registered. EventKind is the closed set of kinds the factory emits, and
// EVENT_TRAITS is the single table every consumer reads instead of keeping its own classification.

import type { EventTraits, LaneStatus } from './event-traits.js';

export type { EventTraits, LaneStatus };
export type {
  AllProvidersDownPayload,
  FlakyTestsPayload,
  LanePausedPayload,
  ParkPayload,
  ProviderAuthRejectedPayload,
  ProviderBreakerClosePayload,
  ProviderCappedPayload,
  ProviderRefusedPayload,
  ProviderRestoredPayload,
  StewardTriggeredPayload,
} from './payloads.js';

export type EventKind =
  | 'pr-adopt-ambiguous'
  | 'pr-adopt-lookup-failed'
  | 'pr-adopted'
  | 'activity_touch_failed'
  | 'adr_context'
  | 'adr_context_empty'
  | 'adr_inject_completed'
  | 'adr_inject_started'
  | 'adr_read_degraded'
  | 'adr_skipped'
  | 'all_providers_down'
  | 'agent_memory_loaded'
  | 'agent_memory_oversized'
  | 'approval_granted'
  | 'approval_requested'
  | 'await-merge'
  | 'awaiting-ci'
  | 'awaiting-review'
  | 'base-hold-cleared'
  | 'baseline-cache-invalidated'
  | 'base_divergence'
  | 'base_push_workflow_failed'
  | 'benchmark-artifacts'
  | 'benchmark-artifacts-failed'
  | 'blocked'
  | 'budget_exceeded'
  | 'build'
  | 'check'
  | 'check-infra'
  | 'check_triage'
  | 'checker_completed'
  | 'checker_started'
  | 'ci-failed'
  | 'ci-infra'
  | 'ci-never-started'
  | 'ci-rescued'
  | 'ci-rescue-failed'
  | 'conflict'
  | 'conflict_detected'
  | 'conflict_resolved'
  | 'config'
  | 'config_unknown_key'
  | 'constitution'
  | 'context_ceiling'
  | 'decompose_comment_posted'
  | 'decompose_duplicate_skipped'
  | 'decompose_failed'
  | 'decompose_file_failed'
  | 'decompose_filed'
  | 'decompose_started'
  | 'defect-window-closed'
  | 'design_artifact_coerced'
  | 'design_artifact_emitted'
  | 'design_artifact_invalid'
  | 'design_artifact_received'
  | 'design_open_questions'
  | 'design_outline_missing'
  | 'design_regression_unresolved'
  | 'design_shallow'
  | 'egress_denied'
  | 'egress_host'
  | 'egress_summary'
  | 'engine-restarted'
  | 'environment_cleanup'
  | 'environment_conflict'
  | 'environment_dotnet'
  | 'environment_lease'
  | 'environment_lease_failed'
  | 'environment_lease_reaped'
  | 'environment_orphan'
  | 'environment_proxy'
  | 'environment_proxy_unavailable'
  | 'environment_release'
  | 'environment_release_failed'
  | 'environment_warning'
  | 'environment-released'
  | 'provider-cap-released'
  | 'escalate'
  | 'evidence'
  | 'fail'
  | 'failover'
  | 'fast_path'
  | 'flaky_tests'
  | 'github_api_deprecated'
  | 'held'
  | 'human-abandoned'
  | 'human-approved'
  | 'human-edited'
  | 'human-merged'
  | 'human-restarted'
  | 'idle'
  | 'ingest_file_overlap_held'
  | 'ingested'
  | 'issue-title'
  | 'issue_deferred'
  | 'issue_unparked'
  | 'iterate_queued'
  | 'iterate_rejected'
  | 'kpi-snapshot'
  | 'kpi-sweep-skipped'
  | 'land'
  | 'lane_file_claim_reaped'
  | 'lane_file_release_failed'
  | 'lane_install'
  | 'lane_install_failed'
  | 'landed'
  | 'lane-done'
  | 'lane-paused'
  | 'lane-start'
  | 'local-only'
  | 'local-only-complete'
  | 'lock-stolen'
  | 'merge-gated'
  | 'merge-gated-override'
  | 'orphan_draft_closed'
  | 'orphan_draft_sweep_capped'
  | 'pr-classified'
  | 'pr_refresh'
  | 'merged'
  | 'model-override'
  | 'model_override_ignored'
  | 'no-pr-complete'
  | 'overnight-fail'
  | 'overnight-park'
  | 'overnight-preflight'
  | 'overnight-ready'
  | 'parked'
  | 'phase_completed'
  | 'phase_snapshot_failed'
  | 'run_state_failed'
  | 'phase_started'
  | 'plan'
  | 'plan_approval_granted'
  | 'plan_reused'
  | 'plan_approval_requested'
  | 'plan_redirect'
  | 'plan_rejected'
  | 'post-merge-defect'
  | 'pr_opened'
  | 'queue_admission_conflict'
  | 'queue_order_conflict'
  | 'queue_added'
  | 'queue_reprioritized'
  | 'queue_rationale_comment_failed'
  | 'project_queue_refresh_failed'
  | 'project_queue_refresh_succeeded'
  | 'provider_auth_rejected'
  | 'provider_breaker_close'
  | 'provider_breaker_open'
  | 'provider_breaker_skip'
  | 'provider_breaker_pinned'
  | 'provider_capped'
  | 'provider_refused'
  | 'provider_restored'
  | 'readiness'
  | 'readiness_enrichment_failed'
  | 'readiness_enrichment_started'
  | 'readiness_enrichment_succeeded'
  | 'ready'
  | 'recovered'
  | 'remote-branch-preexisting'
  | 'resource_limit'
  | 'resume-approved'
  | 'resumed'
  | 'review_rework_queued'
  | 'rework'
  | 'rework_model_failed'
  | 'router'
  | 'run_lock_conflict'
  | 'run-done'
  | 'sandbox'
  | 'sandbox-degraded'
  | 'sandbox-disabled'
  | 'sandbox-env'
  | 'sandbox-unavailable'
  | 'sandbox_auth_denied'
  | 'sandbox_violation'
  | 'ship'
  | 'ship_denied'
  | 'skip-ci'
  | 'stack-fallback'
  | 'skipped-already-closed'
  | 'size-gate-escalated'
  | 'size-gate-decomposed'
  | 'size-gate-sliced'
  | 'size_hint'
  | 'size_gate_cohesive'
  | 'steward-triggered'
  | 'steering_applied'
  | 'steering_unconsumed'
  | 'stop-file-cleared'
  | 'stop-file-set'
  | 'stopped'
  | 'stuck'
  | 'supervisor-done'
  | 'timeout'
  | 'triage'
  | 'triage_accepted'
  | 'usage-stop'
  | 'usage-unavailable'
  | 'usage_coordinator_poll_empty'
  | 'usage_coordinator_poll_failed'
  | 'usage_coordinator_poll_succeeded'
  | 'upstream_report_outboxed'
  | 'upstream_report_sent'
  | 'upstream_report_bumped'
  | 'upstream_report_skipped'
  | 'warn'
  | 'watchdog'
  | 'work-source'
  | 'work_request'
  | 'worker_failover'
  | 'workspace'
  | 'worktree'
  | 'worktree-base'
  | 'worktree-gc';

/** Every existing `EventKind`, classified once. New kinds must be added here —
 *  omitting one is a compile error, which is the point (#663). */
export const EVENT_TRAITS: Record<EventKind, EventTraits> = {
  activity_touch_failed: { severity: 'info', isPark: false, isTerminal: false },
  adr_context: { severity: 'info', isPark: false, isTerminal: false },
  adr_context_empty: { severity: 'info', isPark: false, isTerminal: false },
  adr_inject_completed: { severity: 'info', isPark: false, isTerminal: false },
  adr_inject_started: { severity: 'info', isPark: false, isTerminal: false },
  adr_read_degraded: { severity: 'info', isPark: false, isTerminal: false },
  adr_skipped: { severity: 'info', isPark: false, isTerminal: false },
  // every provider of the stage is down with no known reset; the issue parks once (#3235)
  all_providers_down: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  agent_memory_loaded: { severity: 'info', isPark: false, isTerminal: false },
  agent_memory_oversized: { severity: 'warn', isPark: false, isTerminal: false },
  approval_granted: { severity: 'info', isPark: false, isTerminal: false },
  approval_requested: { severity: 'warn', isPark: false, isTerminal: false },
  'await-merge': { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'waiting-merge' },
  // A PR whose CI never registered a run waits for a backoff re-check (#3208). Not a park.
  'awaiting-ci': { severity: 'info', isPark: false, isTerminal: false },
  'awaiting-review': { severity: 'info', isPark: false, isTerminal: false },
  // A persisted base hold (#2348) ended: origin/main moved or its CI went green (#2350). Not a park.
  'base-hold-cleared': { severity: 'info', isPark: false, isTerminal: false },
  'baseline-cache-invalidated': { severity: 'info', isPark: false, isTerminal: false }, // cached base FAIL dropped: GitHub CI green (#3540)
  base_divergence: { severity: 'warn', isPark: false, isTerminal: false }, // local re-run fails, CI green (#3287)
  base_push_workflow_failed: { severity: 'warn', isPark: false, isTerminal: false }, // non-code push workflow failed (#3290)
  'benchmark-artifacts': { severity: 'info', isPark: false, isTerminal: false },
  'benchmark-artifacts-failed': { severity: 'info', isPark: false, isTerminal: false },
  // Parked while waiting on a filed blocker; the factory resumes it, not a human (#2315).
  // Carries no failure signature, so the steward and the lane breaker skip it.
  blocked: { severity: 'warn', isPark: true, isTerminal: true, laneStatus: 'parked' },
  budget_exceeded: { severity: 'warn', isPark: false, isTerminal: false },
  build: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  check: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  // #3371
  'check-infra': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  check_triage: { severity: 'info', isPark: false, isTerminal: false },
  checker_completed: { severity: 'info', isPark: false, isTerminal: false },
  checker_started: { severity: 'info', isPark: false, isTerminal: false },
  // An infra-classified CI failure was rerun once and the re-watch went green (#2365). Not a park.
  'ci-rescued': { severity: 'info', isPark: false, isTerminal: false },
  'ci-failed': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  // A PR whose one infra rerun also failed for infra on the same SHA (#2366). Parks; not an ADR-0155 steward trigger.
  'ci-infra': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  // An awaiting-ci PR still had no CI run at ci.awaitingCiCapHours (#3208). Parks; a CI or config problem, not a failing build.
  'ci-never-started': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  // The one-shot infra rerun (#2365) did not go green (#2366). Not a park.
  'ci-rescue-failed': { severity: 'warn', isPark: false, isTerminal: false },
  conflict: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  conflict_detected: { severity: 'warn', isPark: false, isTerminal: false },
  conflict_resolved: { severity: 'info', isPark: false, isTerminal: false },
  context_ceiling: { severity: 'info', isPark: false, isTerminal: false },
  // A config-caused CHECK failure parked with file, line and fix (#2583/#2584): fails the same way on every requeue.
  config: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  // An unknown nested config key stripped by the runtime schema, warned once per key at run start (#3568).
  config_unknown_key: { severity: 'warn', isPark: false, isTerminal: false },
  constitution: { severity: 'info', isPark: false, isTerminal: false },
  decompose_comment_posted: { severity: 'info', isPark: false, isTerminal: false },
  decompose_duplicate_skipped: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_failed: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_file_failed: { severity: 'warn', isPark: false, isTerminal: false },
  decompose_filed: { severity: 'info', isPark: false, isTerminal: false },
  decompose_started: { severity: 'info', isPark: false, isTerminal: false },
  'defect-window-closed': { severity: 'info', isPark: false, isTerminal: false },
  design_artifact_coerced: { severity: 'warn', isPark: false, isTerminal: false },
  design_artifact_emitted: { severity: 'info', isPark: false, isTerminal: false },
  design_artifact_invalid: { severity: 'warn', isPark: false, isTerminal: false },
  design_artifact_received: { severity: 'info', isPark: false, isTerminal: false },
  design_outline_missing: { severity: 'warn', isPark: false, isTerminal: false },
  design_regression_unresolved: { severity: 'warn', isPark: false, isTerminal: false },
  design_open_questions: { severity: 'warn', isPark: false, isTerminal: false },
  design_shallow: { severity: 'info', isPark: false, isTerminal: false },
  // factoryd restarted a stale in-process engine (#1178) — operational anomaly, not a park or terminal.
  egress_denied: { severity: 'warn', isPark: false, isTerminal: false },
  egress_host: { severity: 'info', isPark: false, isTerminal: false },
  egress_summary: { severity: 'info', isPark: false, isTerminal: false },
  'engine-restarted': { severity: 'warn', isPark: false, isTerminal: false },
  environment_cleanup: { severity: 'info', isPark: false, isTerminal: false },
  environment_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  environment_dotnet: { severity: 'info', isPark: false, isTerminal: false },
  environment_lease: { severity: 'info', isPark: false, isTerminal: false },
  environment_lease_failed: { severity: 'info', isPark: false, isTerminal: false },
  environment_lease_reaped: { severity: 'info', isPark: false, isTerminal: false },
  environment_orphan: { severity: 'warn', isPark: false, isTerminal: false },
  environment_proxy: { severity: 'info', isPark: false, isTerminal: false },
  environment_proxy_unavailable: { severity: 'info', isPark: false, isTerminal: false },
  environment_release: { severity: 'info', isPark: false, isTerminal: false },
  environment_release_failed: { severity: 'info', isPark: false, isTerminal: false },
  environment_warning: { severity: 'warn', isPark: false, isTerminal: false },
  'environment-released': { severity: 'warn', isPark: false, isTerminal: true },
  'provider-cap-released': { severity: 'warn', isPark: false, isTerminal: true },
  escalate: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  evidence: { severity: 'info', isPark: false, isTerminal: false },
  fail: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  failover: { severity: 'info', isPark: false, isTerminal: false },
  fast_path: { severity: 'info', isPark: false, isTerminal: false },
  // CHECK's serial re-run verdict for a base-red tests checker (#2302); evidence only, not a park.
  flaky_tests: { severity: 'info', isPark: false, isTerminal: false },
  // A GitHub REST call answered with a Deprecation header (#2218); logged once per route per run.
  github_api_deprecated: { severity: 'warn', isPark: false, isTerminal: false },
  // A lane parked on the exact same checker-failure signature it parked on in
  // a prior run (ReworkHistory, #740) — distinct from 'escalate'/'fail' so a
  // watchdog or human scanning events.ndjson can tell "already tried and
  // failed identically once, needs a decision" apart from a fresh park.
  held: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  'human-abandoned': { severity: 'info', isPark: false, isTerminal: true },
  'human-approved': { severity: 'info', isPark: false, isTerminal: false },
  'human-edited': { severity: 'info', isPark: false, isTerminal: false },
  'human-merged': { severity: 'info', isPark: false, isTerminal: true },
  'human-restarted': { severity: 'info', isPark: false, isTerminal: false },
  idle: { severity: 'info', isPark: false, isTerminal: false },
  ingest_file_overlap_held: { severity: 'warn', isPark: false, isTerminal: false },
  ingested: { severity: 'info', isPark: false, isTerminal: false },
  'issue-title': { severity: 'info', isPark: false, isTerminal: false },
  issue_deferred: { severity: 'info', isPark: false, isTerminal: false },
  issue_unparked: { severity: 'info', isPark: false, isTerminal: false },
  'kpi-snapshot': { severity: 'info', isPark: false, isTerminal: false },
  // End-of-run KPI sweep not run: the run opened no PR and merged nothing.
  'kpi-sweep-skipped': { severity: 'info', isPark: false, isTerminal: false },
  land: { severity: 'info', isPark: false, isTerminal: false },
  lane_file_claim_reaped: { severity: 'info', isPark: false, isTerminal: false },
  lane_file_release_failed: { severity: 'warn', isPark: false, isTerminal: false },
  lane_install: { severity: 'info', isPark: false, isTerminal: false },
  lane_install_failed: { severity: 'warn', isPark: false, isTerminal: false },
  landed: { severity: 'info', isPark: false, isTerminal: true, laneStatus: 'merged' },
  'lane-done': { severity: 'info', isPark: false, isTerminal: false },
  // The lane circuit breaker stopped claiming issues (#1906). Not a park: both
  // issues already logged their own park, so counting this too would double
  // human-intervention KPIs. No laneStatus: LaneStatus has no paused state yet.
  'lane-paused': { severity: 'warn', isPark: false, isTerminal: false },
  'lane-start': { severity: 'info', isPark: false, isTerminal: false },
  'local-only': { severity: 'info', isPark: false, isTerminal: false },
  'local-only-complete': { severity: 'info', isPark: false, isTerminal: false },
  'lock-stolen': { severity: 'info', isPark: false, isTerminal: false },
  'merge-gated': { severity: 'info', isPark: false, isTerminal: false },
  'merge-gated-override': { severity: 'warn', isPark: false, isTerminal: false },
  'pr-adopt-ambiguous': { severity: 'warn', isPark: false, isTerminal: false },
  'pr-adopt-lookup-failed': { severity: 'warn', isPark: false, isTerminal: false },
  'pr-adopted': { severity: 'info', isPark: false, isTerminal: false },
  'pr-classified': { severity: 'info', isPark: false, isTerminal: false },
  orphan_draft_closed: { severity: 'info', isPark: false, isTerminal: false },
  orphan_draft_sweep_capped: { severity: 'warn', isPark: false, isTerminal: false },
  pr_refresh: { severity: 'info', isPark: false, isTerminal: false },
  merged: { severity: 'info', isPark: false, isTerminal: true },
  'model-override': { severity: 'info', isPark: false, isTerminal: false },
  model_override_ignored: { severity: 'warn', isPark: false, isTerminal: false },
  'no-pr-complete': { severity: 'info', isPark: false, isTerminal: true },
  'overnight-fail': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-park': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-preflight': { severity: 'info', isPark: false, isTerminal: false },
  'overnight-ready': { severity: 'info', isPark: false, isTerminal: false },
  parked: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  phase_completed: { severity: 'info', isPark: false, isTerminal: false },
  phase_snapshot_failed: { severity: 'info', isPark: false, isTerminal: false },
  run_state_failed: { severity: 'info', isPark: false, isTerminal: false },
  phase_started: { severity: 'info', isPark: false, isTerminal: false },
  plan: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  plan_approval_granted: { severity: 'info', isPark: false, isTerminal: false },
  plan_reused: { severity: 'info', isPark: false, isTerminal: false },
  plan_approval_requested: { severity: 'info', isPark: false, isTerminal: false },
  plan_redirect: { severity: 'info', isPark: false, isTerminal: false },
  plan_rejected: { severity: 'info', isPark: false, isTerminal: false },
  'post-merge-defect': { severity: 'info', isPark: false, isTerminal: false },
  pr_opened: { severity: 'info', isPark: false, isTerminal: false },
  queue_added: { severity: 'info', isPark: false, isTerminal: false },
  queue_admission_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  queue_order_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  queue_reprioritized: { severity: 'info', isPark: false, isTerminal: false },
  queue_rationale_comment_failed: { severity: 'warn', isPark: false, isTerminal: false },
  project_queue_refresh_failed: { severity: 'warn', isPark: false, isTerminal: false },
  project_queue_refresh_succeeded: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_close: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_open: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_skip: { severity: 'info', isPark: false, isTerminal: false },
  provider_breaker_pinned: { severity: 'info', isPark: false, isTerminal: false },
  provider_auth_rejected: { severity: 'warn', isPark: false, isTerminal: false },
  provider_capped: { severity: 'warn', isPark: false, isTerminal: false },
  provider_refused: { severity: 'warn', isPark: false, isTerminal: false },
  provider_restored: { severity: 'info', isPark: false, isTerminal: false },
  readiness: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_failed: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_started: { severity: 'info', isPark: false, isTerminal: false },
  readiness_enrichment_succeeded: { severity: 'info', isPark: false, isTerminal: false },
  ready: { severity: 'info', isPark: false, isTerminal: true, laneStatus: 'ready' },
  recovered: { severity: 'info', isPark: false, isTerminal: false },
  'remote-branch-preexisting': { severity: 'info', isPark: false, isTerminal: false },
  resource_limit: { severity: 'warn', isPark: false, isTerminal: false },
  'resume-approved': { severity: 'info', isPark: false, isTerminal: false },
  resumed: { severity: 'info', isPark: false, isTerminal: false },
  // A trusted changes-requested review queued its issue for review rework (#3563). Not a park.
  // A trusted `/factory iterate` comment queued (or was rejected for) its issue (#3625). Not a park.
  iterate_queued: { severity: 'info', isPark: false, isTerminal: false },
  iterate_rejected: { severity: 'warn', isPark: false, isTerminal: false },
  review_rework_queued: { severity: 'info', isPark: false, isTerminal: false },
  rework: { severity: 'warn', isPark: false, isTerminal: false, laneStatus: 'running' },
  rework_model_failed: { severity: 'warn', isPark: false, isTerminal: false },
  router: { severity: 'info', isPark: false, isTerminal: false },
  run_lock_conflict: { severity: 'warn', isPark: false, isTerminal: false },
  'run-done': { severity: 'info', isPark: false, isTerminal: true },
  sandbox: { severity: 'info', isPark: false, isTerminal: false },
  'sandbox-degraded': { severity: 'warn', isPark: false, isTerminal: false },
  'sandbox-disabled': { severity: 'warn', isPark: false, isTerminal: false },
  // A sandbox denied a loopback bind (#3332): environment, not code; parks on the first hit with no rework.
  'sandbox-env': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'parked' },
  'sandbox-unavailable': { severity: 'warn', isPark: false, isTerminal: false },
  sandbox_auth_denied: { severity: 'warn', isPark: false, isTerminal: false },
  sandbox_violation: { severity: 'warn', isPark: false, isTerminal: false },
  ship: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  ship_denied: { severity: 'error', isPark: false, isTerminal: true, laneStatus: 'failed' },
  // ADR-0161: the native stack API failed; the issue fell back to slice mode (#2672).
  'stack-fallback': { severity: 'warn', isPark: false, isTerminal: false },
  'skip-ci': { severity: 'info', isPark: false, isTerminal: false },
  // Target issue already closed at run start: a clean terminal outcome, never a park (#681).
  'skipped-already-closed': { severity: 'info', isPark: false, isTerminal: true },
  'size-gate-escalated': { severity: 'warn', isPark: false, isTerminal: false },
  // #2662: a file-mode size-gate trip filed its decomposition as sub-issues — no human escalation.
  'size-gate-decomposed': { severity: 'info', isPark: false, isTerminal: false },
  // ADR-0147: the oversized issue was kept whole and a slice plan was recorded.
  'size-gate-sliced': { severity: 'info', isPark: false, isTerminal: false },
  size_gate_cohesive: { severity: 'info', isPark: false, isTerminal: false }, // slicer slices mostly edit the same files; issue kept whole (#3351)
  size_hint: { severity: 'warn', isPark: false, isTerminal: false }, // in-scope/AC counts read large; hint only (#3350)
  // Steward picked up a parked run (ADR-0155). Not a park: the run already logged its own park.
  'steward-triggered': { severity: 'info', isPark: false, isTerminal: false },
  steering_applied: { severity: 'info', isPark: false, isTerminal: false },
  steering_unconsumed: { severity: 'info', isPark: false, isTerminal: false },
  'stop-file-cleared': { severity: 'warn', isPark: false, isTerminal: false },
  'stop-file-set': { severity: 'warn', isPark: false, isTerminal: false },
  stopped: { severity: 'warn', isPark: false, isTerminal: true, laneStatus: 'stopped' },
  stuck: { severity: 'warn', isPark: true, isTerminal: false },
  'supervisor-done': { severity: 'info', isPark: false, isTerminal: false },
  timeout: { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  triage: { severity: 'info', isPark: false, isTerminal: false, laneStatus: 'running' },
  triage_accepted: { severity: 'info', isPark: false, isTerminal: false },
  'usage-stop': { severity: 'info', isPark: false, isTerminal: false },
  'usage-unavailable': { severity: 'info', isPark: false, isTerminal: false },
  usage_coordinator_poll_empty: { severity: 'warn', isPark: false, isTerminal: false },
  usage_coordinator_poll_failed: { severity: 'warn', isPark: false, isTerminal: false },
  usage_coordinator_poll_succeeded: { severity: 'info', isPark: false, isTerminal: false },
  upstream_report_outboxed: { severity: 'warn', isPark: false, isTerminal: false },
  upstream_report_sent: { severity: 'info', isPark: false, isTerminal: false },
  upstream_report_bumped: { severity: 'info', isPark: false, isTerminal: false },
  upstream_report_skipped: { severity: 'info', isPark: false, isTerminal: false },
  warn: { severity: 'warn', isPark: false, isTerminal: false },
  watchdog: { severity: 'info', isPark: false, isTerminal: false },
  'work-source': { severity: 'info', isPark: false, isTerminal: false },
  work_request: { severity: 'info', isPark: false, isTerminal: false },
  worker_failover: { severity: 'info', isPark: false, isTerminal: false },
  workspace: { severity: 'info', isPark: false, isTerminal: false },
  worktree: { severity: 'info', isPark: false, isTerminal: false },
  'worktree-base': { severity: 'info', isPark: false, isTerminal: false },
  'worktree-gc': { severity: 'info', isPark: false, isTerminal: false },
};

export { eventTraitsFor, isParkKind, laneStatusOf, severityOf, UNKNOWN_EVENT_TRAITS } from './kind-lookup.js';
