# ADR-0097: The app's lane visual state is an explicit lifecycle-frame field, and staleness is frame recency

- Status: Accepted
- Date: 2026-09-12

## Context

`factory tui` can tell a lane waiting for merge from a dead one and a parked lane from a
failed one because it replays `.factory/state/events.ndjson`, maps each FactoryEvent kind
through `laneStatusOf` (packages/core/src/events/kinds.ts), and cross-checks quiet lanes
against the per-issue phase-snapshot heartbeat `RunPhaseSnapshot.lastActivityAt`
(ADR-0086, ADR-0093). The app has none of that. It is a browser bundle whose only lane signal
is the `LaneLifecycleEvent` frames `packages/server` relays over SSE, and it may import only
`@on-par/contracts` and the browser-safe `@on-par/factory-core/kpis` subpath (ADR-0013) — the
event-kind tables, the events file and the snapshot heartbeat all live behind Node-only code
it cannot load.

That leaves two ways to give the app parity. It could infer: treat a `ship`/`done` frame as
"waiting for merge" and pattern-match `detail` strings to spot a park. Or the producer could
say so on the frame. Inference is a guess about state the engine knows for certain, it repeats
the detail-string coupling ADR-0094 rejected for attach failures, and — decisively — an
inferred waiting-merge can never be refreshed, because no frame follows ship-done. Without a
recurring signal the app cannot tell a live merge wait from a killed run, which is the whole
complaint behind #1385 (epic #1377).

## Decision

`LaneLifecycleEventSchema` gains one additive optional field, `laneState`, with the values
`'waiting-merge'` and `'parked'`. A producer that starts waiting, or parks a lane for a human,
states it on the frame; the park reason is the frame's existing `detail`, never a second field
and never re-derived by the app. Frames that omit `laneState` parse exactly as before, so every
existing producer, the server relay and the replay ring are unaffected.

The app treats frame recency as the lane heartbeat. `laneProgress`
(packages/dashboard/src/laneProgress.ts) is the single place lane visual state is decided: a
lane is `stale` only when it is non-terminal and its most recent frame is older than
`STALE_AFTER_MS`. `waiting-merge` is non-terminal, so a producer that keeps emitting heartbeat
frames keeps such a lane out of `stale` indefinitely; `parked`, `failed` and shipped lanes are
terminal and are never stale, mirroring ADR-0093's rule that terminal lanes are never hidden.
`STALE_AFTER_MS` is 15 minutes, deliberately duplicated from core's
`DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS` because that export is only reachable from the
Node-only root entry point — the same mirroring compromise ADR-0094 accepted for
`AttachFailureReason`.

## Consequences

Positive: a live merge wait and a killed run are now different things on screen, and the app's
rule is the TUI's rule; the park reason shown is the engine's own message; the contract change
is additive-optional, so no existing frame, reader or relay changes; all lane-state policy sits
in one pure, fully-tested module rather than spread through JSX.

Negative: a producer that waits without heartbeating will read as stale after 15 minutes — the
obligation moves onto producers, which is intended but is a new requirement. The 15-minute
threshold now exists in two packages and must be moved in both. Until engine-side emission
lands (the sibling story under #1377), no live frame sets `laneState`, so the two new states
are reachable in tests and hand-driven SSE only. The app deliberately cannot show a state the
engine never declares — any future lane state needs a contract value, not a clever inference.

## References

- [Issue #1385 — Progress visuals: phase timeline handles waiting, parked, and stale states](https://github.com/on-par/software-factory/issues/1385)
- [ADR-0093 — The TUI Active tab is scoped to the current run and hides heartbeat-stale lanes](docs/adr/0093-the-tui-active-tab-is-scoped-to-the-current-run-and-hides-heartbeat-stale-lanes.md)
- [ADR-0086 — Local queue entry staleness is judged from the per-issue phase-snapshot heartbeat](docs/adr/0086-local-queue-entry-staleness-is-judged-from-the-per-issue-phase-snapshot-heartbeat-not-the-queue-files-mtime.md)
- [ADR-0094 — The app explains an attach rejection from factoryd's reason code, never from its detail string](docs/adr/0094-the-app-explains-an-attach-rejection-from-factoryd-s-reason-code-never-from-its-detail-string.md)
