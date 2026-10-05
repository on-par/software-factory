# ADR-0144: The stuck-run steward examines only runs parked as fail after 3 rework rounds or ci-failed with the PR open, and never environment, budget, held, timeout or conflict

- Status: Accepted
- Date: 2026-10-05

## Context

The factory parks or releases runs for many reasons. `ParkReason` in `packages/core/src/run/outcome.ts` is `escalate | timeout | fail | conflict | ci-failed | held`. `RunOutcome` also has `released` with reason `environment` (#1928, ADR-0141). A steward that spends model budget on a parked run is only worth it when the run is stuck on its own change. Environment failures, budget breaches, cross-run holds, timeouts and conflicts need a human, an ops fix or a re-queue, not another agent pass. Without a written rule, later stories could hook the steward to any park event.

## Decision

The steward examines a run only when it matches one of the two triggers below, and never otherwise.

### Triggers

1. **CHECK failed after 3 rework rounds.** `checkPhase` used all `MAX_REWORK_ROUNDS` (3, `packages/core/src/phases/check.ts`) and CHECK still fails, so `runIssue` (`packages/core/src/run/run-issue.ts`) parks the run with reason `fail`.
2. **SHIP failed with the PR open or under watch.** SHIP opened the PR and the CI watch confirmed a failure or never reached green (`CiFailedError` / `CiUnverifiedError` in `packages/cli/src/cli/index.ts`), so the run parks with reason `ci-failed`.

### Non-triggers

- **Environment releases.** The outcome is `released` with reason `environment`, because every failing checker also fails on the base SHA (ADR-0141). The base is broken, not the change.
- **Budget parks.** The per-issue budget cap was exceeded (`budget_exceeded`, parked `fail`). These are excluded even though the reason is `fail`, because a steward pass would spend more of the exhausted budget.
- **Held.** Reason `held`. The same failure signature parked the issue in a prior run, and the issue needs a human decision.
- **Timeout.** Reason `timeout`. A phase exceeded its timeout, which is an ops or sizing problem.
- **Conflict.** Reason `conflict`. A merge conflict with the base branch needs a rebase, not a fix to the change.

Adding a trigger, or removing a non-trigger, requires a new ADR that supersedes this one.

## Consequences

The steward never spends budget on environment, budget, hold, timeout or conflict states, and those keep their current human and ops paths. A `fail` park is a trigger only when it came from CHECK after the rework cap, so the steward must tell it apart from a budget `fail`. `escalate` parks (identical failures across rounds, ADR-0017 and stuck accounting) are not covered here and are left to the escalation story of #1942. The packet, output schema, escalation, surface and safety rules are recorded in later ADRs.

References: #1984, parent #1942.
