# ADR-0110: Same-file lane guard parks immediately on collision, reusing the 'held' park reason

- Status: Accepted
- Date: 2026-09-18

## Context

factory-app's 2026-09-17 retro found the scheduler runs claimed issues in parallel
lanes with no awareness that two lanes' PLAN phases decided to touch the same file —
#568/#598 and #537/#540 both wrote conflicting diffs to the same file because nothing
stopped the second lane once the first was already in flight. This is the layer beneath
the admission-time file-overlap guard (ADR-0109/#1518): it catches overlap only PLAN
itself discovers, after a claimed issue is already mid-flight.

PLAN already produces a structured DesignArtifact with two fields that are
contractually required to be real, checkout-relative paths — `targetTypes[].file` and
`signatures[].file` — unlike the free-text `interfacesTouched` field PLAN's own prompt
lets it fill with bare symbol names.

The issue's acceptance criteria explicitly allow two shapes for how the second run
responds to a collision: wait for the first lane to finish, or park immediately naming
the collision. `RunOutcome` (packages/core/src/run/outcome.ts) is a closed,
pervasively-consumed union (TUI, dashboard, kpis, reports, the CLI's `LaneParkError`
re-raise) with a closed `ParkReason` enum sourced from `EventKind`; a wait/requeue
behavior would need a new `RunOutcome` state and new bookkeeping in the CLI's `runLane`
to hold a GitHub claim open across a self-requeue, materially larger than parking, which
reuses machinery ('held' already exists for the cross-run-stuck-failure case, flows
through `terminalParked` → `LaneParkError` → `runLane`'s existing 'parked' branch →
`GithubQueue.release(issue, 'parked')` unchanged).

## Decision

The same-file lane guard parks the second run immediately on a detected collision,
using the existing `ParkReason` value `'held'` (not a new `EventKind`), with a message
naming both the colliding issue number and the colliding file. It does not implement a
wait/retry/requeue behavior in this pass. Collision detection reads only
`DesignArtifact.targetTypes[].file` (excluding entries whose `kind` is `'read'`) and
`DesignArtifact.signatures[].file` — never the free-text `interfacesTouched` field — as
the run's touched-files set, registered in a new file-backed registry
(packages/core/src/run/lane-file-guard.ts, `LaneFileGuard`, structurally mirroring
`ProviderBreaker`) keyed by repo+issue, for the run's duration between a successful PLAN
and the run's terminal exit.

## Consequences

Positive: reuses existing, already-tested park plumbing end to end (`terminalParked`,
`LaneParkError`, `runLane`, `GithubQueue.release`) with zero change to `RunOutcome`'s
shape or any of its consumers; the guard is a strictly additive, optional `RunPorts`
field, so every existing `runIssue` caller and test that doesn't wire it sees no
behavior change.

Negative: a park strips the issue's 'factory:queued' GitHub label, so a same-file
collision — often a transient condition that resolves itself as soon as the first lane
finishes — requires a human to notice the 'held' park and re-queue the issue, rather
than the factory automatically retrying it once the path is free. This is a deliberate
tradeoff for this pass's scope, not a permanent design conclusion; a future issue could
add a genuine wait/requeue behavior if parked-for-collision volume proves operationally
painful, at the cost of the `RunOutcome`/`runLane` surface this decision avoided growing
now.

No reap/TTL exists for a claim left behind by a run whose process is killed before
`runIssue`'s `finally` block runs (e.g. SIGKILL). Unlike the port-lease registry's
pid-liveness reap (packages/core/src/environment/index.ts) or the queue's claim-expiry
lease (ADR-0104/0105), `lane-files.json` has no staleness detection — a genuinely
orphaned claim blocks that file until `.factory/state` is hand-edited. This mirrors
`ProviderBreaker`'s own accepted no-lock/no-reap tradeoff for a much lower-frequency
failure mode, and is flagged as a candidate follow-up rather than a blocker.

## References

- Issue #1515: scheduler: same-file lane guard — forbid two in-flight runs claiming the
  same primary path
  https://github.com/on-par/software-factory/issues/1515
