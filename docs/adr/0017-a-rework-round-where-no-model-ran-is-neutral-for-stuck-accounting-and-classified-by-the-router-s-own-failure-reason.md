# ADR-0017: A rework round where no model ran is neutral for stuck accounting and classified by the router's own failure reason

- Status: Accepted
- Date: 2026-08-12

## Context

`ModelRouter.run` throws only after every eligible model for a task is exhausted, and the
error it throws carries `.reason` (a `FailoverReason`) and `.attempts`. CHECK's rework loop
discarded that error with `.catch(() => null)` (`packages/core/src/phases/check.ts`), which
collapsed two very different situations into one: "the worker ran and failed to fix the
failures" and "no worker model ever ran". Because `classifyReworkCause` could only see the
`failovers` list — empty when a single-model tier is exhausted, since `failoversFrom` records
only attempts followed by a _different_ model — a provider quota outage was recorded as
`cause: 'factory-fault'`. The round still counted, the checkers still re-ran, the failure
signature was necessarily identical, and after `STUCK_THRESHOLD` (2) rounds the lane logged
`'stuck'` with `cause: 'factory-fault'`. The `stuckRate` and rework-cause KPIs the factory
reports on therefore read provider outages as worker incompetence, and no event anywhere in
the log said the model call had not happened. The same failure classes are already treated as
not-our-fault elsewhere: `EXTERNAL_REASONS` exists in this file, and BUILD already reads
`err.reason` / `err.attempts` off the router error rather than swallowing it.

## Decision

The rework loop distinguishes "the worker ran" from "no model ran", and treats the second as
evidence about the provider, never about the work.

`reworkWorker` catches the router error explicitly, reads `reason` and `attempts` off it, and
returns `{ failovers, modelCompleted, failureReason }`. It emits a `rework_model_failed`
event — a registered `EventKind`, `warn` severity, non-park, non-terminal — carrying the
failure reason and the rendered attempt summary, so a round in which no model ran is always
visible in `.factory/events.ndjson`.

`classifyReworkCause` takes the captured `failureReason` in addition to `failovers` and
returns `'external'` whenever that reason is a member of `EXTERNAL_REASONS`
(`rate_limit`, `usage_cap`, `timeout`, `unavailable`) — including when `failovers` is empty
because only one model was eligible.

A round with `modelCompleted === false` is neutral for no-progress accounting: `checkPhase`
neither increments nor resets `noProgressStreak` for it. Neutral rather than reset, because a
quota outage is no evidence that the preceding genuinely-unproductive rounds made progress.
The round is still counted in `reworkRounds` and the checkers still re-run, so the loop stays
bounded by `maxReworkRounds` exactly as before.

## Consequences

Positive: quota and provider outages can no longer drive a lane into a false `'stuck'` state,
and can no longer be attributed to the worker in the rework-cause and `stuckRate` KPIs. A
round where no model ran is now observable rather than silent. The `failover` events for real
model switches recorded on a failed run's attempts are emitted instead of dropped.

Negative: a lane that alternates genuine no-progress rounds with provider outages needs more
rounds to be declared stuck, so a real stuck lane can consume its full `maxReworkRounds`
before parking on the existing `fail` path. Each outage round still pays for a full
`runAllCheckers` pass whose outcome is a foregone conclusion. The structurally identical
`.catch(() => null)` on the `dispute_resolution` call remains, so the two rework-adjacent
router call sites now handle failure differently until that one is addressed separately.

## References

- [Issue #642 — CHECK rework swallows router failure](https://github.com/on-par/software-factory/issues/642)
- [ADR-0014 — CI merge gate fails closed on non-allow-listed check conclusions](docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
