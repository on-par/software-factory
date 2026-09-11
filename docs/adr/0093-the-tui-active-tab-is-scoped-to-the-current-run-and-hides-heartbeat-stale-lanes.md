# ADR-0093: The TUI Active tab is scoped to the current run and hides heartbeat-stale lanes

- Status: Accepted
- Date: 2026-09-11

## Context

`factory tui` builds its Active tab by replaying `.factory/state/events.ndjson`
from the beginning through `reduceDashboard` (ADR-0002 makes the event log
the single source). A lane left `running` / `ready` / `waiting-merge` only
on a terminal event the run itself logged. Two consequences on any
long-lived checkout (#1369): the log accumulates every run ever made (161
on the Mini's factory-app checkout) and `run-done` never dropped the
finished run's lanes; and a PR merged outside the run — by the auto-merge
sweep, `factory land`, or a person — logs no `landed` event, so its lane
sat at "waiting to merge" for days. A run killed mid-issue left `running`
lanes the same way.

`factory status` already solved the equivalent problem for local claims:
ADR-0086 judges staleness per issue from the phase-snapshot heartbeat
(`RunPhaseSnapshot.lastActivityAt`, #1326), and ADR-0087 keeps its Active
band to genuinely live work.

## Decision

1. **A run boundary clears the board.** On `run-done` (issue `all`),
   `reduceDashboard` drops every lane. A finished run has no active lanes by
   definition. The first lane event after that starts the next run's set
   and clears `runDone`. Replaying a log that holds many runs therefore
   leaves only the run in progress.
2. **Quiet non-terminal lanes are hidden, with a count.** Each lane records
   `lastEventAt`. `partitionLanesByActivity` hides a lane at `running`,
   `ready`, or `waiting-merge` when neither its last event nor its
   phase-snapshot heartbeat is within
   `DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS` (15 min, shared with `factory
status`). Terminal lanes of the current run (`merged`, `failed`,
   `parked`, `stopped`) are never hidden. The Active tab shows `(N stale
lane(s) hidden — no activity for 15m; run factory doctor --reconcile)`.
3. **The heartbeat comes from `runsDir`.** `RunTuiOptions.runsDir`
   (`.factory/state/runs`) lets the App poll `readPhaseSnapshot` for the
   lanes it holds; the reader is injectable. Without `runsDir` only the
   event timestamp applies.
4. **No GitHub lookups for PR state.** ADR-0067 keeps execution state
   local; the run boundary plus heartbeat is sufficient and needs no
   network.

## Consequences

- The merge-train position, lane count, selection index, steering target,
  and the Queue tab's lane join all use the active set, so a hidden lane
  cannot be selected or steered.
- A lane legitimately waiting on a slow CI run stays visible only while the
  run keeps its heartbeat fresh; if the run dies, the lane ages out in 15
  minutes instead of persisting forever, which is the truthful outcome.
- `LaneState` gains a required `lastEventAt`; `DashboardState.runDone` is
  now cleared by the next lane event instead of latching.
- The idle-reason and compact-summary work in #1365 builds on the same
  active set.
