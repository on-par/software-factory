# ADR-0177: The run lifecycle is one canonical state machine, with lossless projections to the legacy vocabularies

- Status: Accepted
- Date: 2026-11-08
- See also: [ADR-0029](0029-lane-lifecycle-events-are-an-in-process-fan-out-never-a-second-source-of-truth.md) (lifecycle bus), [ADR-0038](0038-the-status-board-s-lane-set-is-derived-only-from-the-live-event-stream-never-from-a-snapshot.md) and [ADR-0039](0039-the-status-board-is-a-pure-projection-of-the-sse-stream-and-unobserved-state-is-pending-never-inferred.md) (status board projection), [ADR-0054](0054-runoutcome-is-a-core-owned-value-type-park-classification-is-structural-not-instanceof.md) (RunOutcome), [ADR-0103](0103-durable-isolated-daemon-delivery-lanes.md) (daemon lanes), [ADR-0174](0174-a-run-persists-its-resumable-state-in-a-factory-owned-pr-comment.md) (PR run state)

## Context

One issue's run has a single real lifecycle: queued → claimed → PLAN → BUILD → CHECK (with rework) → SHIP → CI → review/merge, or a terminal park/fail/stop. The code described that lifecycle with at least six independent vocabularies:

- `RunStatus` (12 members) in the persisted `IssueRunState`.
- `RunOutcome.state` (5 members, with `reason` sub-unions) as the terminal result.
- `FailurePhase` (`plan` | `build` | `check` | `ship`).
- `PrRunStatus` (4 members) in the resumable PR comment.
- `LaneStatus` (7 members) folded by the TUI/queue dashboard reducer from the event stream.
- `EventKind` (250+ members) with `EVENT_TRAITS` (`isPark`, `isTerminal`, `laneStatus`).

They drifted at the edges. A lane can read `failed` while its run record says `parked`; the PR comment says `parked` while the label says `ci-failed`. `LaneStatus` had no paused state, so the lane circuit breaker could not be shown (`events/kinds.ts` says so in a comment). Adding a state meant editing several hand-synced tables, and no illegal transition was a compile error. Agents had to reverse-engineer the current state from labels, an event log and three JSON stores.

The repo already has the right pattern: `EVENT_TRAITS` is "the single table every consumer reads instead of keeping its own classification" (#663). The lifecycle needed the same treatment for state, not just for events.

## Decision

1. **One canonical machine.** `packages/core/src/lifecycle/lifecycle.ts` defines `LIFECYCLE_STATES` (16 states), `LIFECYCLE_TRANSITIONS` (every legal structural edge), and the flags `TERMINAL_LIFECYCLE_STATES`, `RESUMABLE_LIFECYCLE_STATES` and `FINAL_LIFECYCLE_STATES`. Adding a state is a compile error until its label, projections and transition row exist.
2. **Edges are structural; guards stay in the engine.** `canTransitionLifecycle`/`assertLifecycleTransition` say which edges exist. Budgets, claims, labels and CI still decide whether an edge is taken. The table never grants permission; it only prevents naming a transition that was never designed.
3. **The legacy vocabularies become projections.** `toRunStatus`, `fromRunStatus`, `laneStatusFromLifecycle`, `fromLaneStatus`, `prRunStatusFromLifecycle` and `LIFECYCLE_LABELS` derive from the machine. `fromRunStatus`/`toRunStatus` round-trip all 12 `RunStatus` members, and `prRunStatusFromLifecycle(fromRunStatus(s))` equals `prRunStatusFor(s, false)`, so no consumer changes behavior. Migrating a consumer is replacing its hand-written mapping with the projection.
4. **`paused` is a first-class state.** The lane circuit breaker and base hold now have a name and a resumption edge (`paused → queued`). Its legacy `LaneStatus` projection is `parked` until the TUI reads the canonical state directly, which is the documented gap this ADR starts to close.
5. **AX gets a descriptor.** `describeLifecycle()` returns the whole machine as plain JSON: every state, its label, its terminal/resumable/final flags, its projections and its edges. Docs, dashboards and the factory's own agents read that instead of reverse-engineering the log.
6. **Additive, not a big bang.** No engine call site reads the machine yet. This ADR fixes the source of truth and the projections; later PRs move one consumer at a time, each verified by the round-trip and equivalence tests.

## Consequences

- Adding or renaming a lifecycle state is one table edit, checked by the compiler and by exhaustive tests. The five legacy tables no longer need hand-syncing.
- A lane can finally show `Paused`. The other legacy projections are unchanged, so existing tests and outputs stay green.
- `RunStatus` stays the persisted type and `LaneStatus` stays the dashboard type; they become views of the machine rather than rivals.
- The transition table is deliberately permissive at park/fail/stop, because a human or the factory can requeue them. It is a structural contract, not a runtime authorization.
- The canonical machine has 16 states while `RunStatus` has 12: `claimed`, `awaiting-ci`, `stopped` and `paused` collapse onto existing `RunStatus` members. That loss is explicit in `toRunStatus` and covered by the round-trip test for the 12 real members.

## Alternatives considered

- **Replace `RunStatus` with the canonical state in one PR.** Rejected: it changes persisted JSON, the public read paths and every consumer at once, with no behavior change to show for the risk. Projections let the migration be incremental and reversible.
- **Keep the separate vocabularies and document the mapping.** Rejected: that is what the code already did, and the drift was the bug. Documentation does not fail a build; an exhaustiveness check does.
- **Make the machine authoritative for guards too.** Rejected: guards need live evidence (claims, budgets, labels, CI) that a pure state table must not own. Structural edges plus engine guards keep the table honest and testable.
- **One `LaneStatus` with a paused member instead of a canonical machine.** Rejected: it fixes one symptom (paused) and leaves the `RunStatus`/`RunOutcome`/`PrRunStatus` drift untouched.
