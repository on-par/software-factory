# ADR-0016: waitForMerge parks the lane on sustained or permanently-failing merge-state checks

- Status: Accepted
- Date: 2026-08-12

## Context

`waitForMerge` (`packages/cli/src/cli/index.ts`) is the last phase of a lane: after SHIP opens
the PR, it polls GitHub every 120 seconds until the PR is merged or a STOP file appears. Its
error handling deliberately treats a failed merged-state check as "not merged yet", which is
the right default for a transient fault — a rate limit, a 5xx, a dropped connection — because
the next poll will simply retry.

That default had no bound. The loop had no attempt counter, no wall-clock deadline, and no
classification of the underlying error, so a fault that never recovers looked identical to
one that recovers on the next tick. The concrete production failure (#646): the `gh auth
token` that `getOctokit` reads expires mid-run, every `isPrMerged` call 401s, and with
auto-merge off the lane spins forever — one `warn` event every two minutes, no escalation, no
park — until a human notices and drops a STOP file. This is the same "parked lane with no
retry or escalation" class as #550.

Two forces pull against each other. Escalating too eagerly turns GitHub's ordinary
rate-limiting into false parks, and GitHub signals both primary and secondary rate limits
with HTTP 403 — the same status it uses for a genuinely insufficient token scope. Escalating
too late (or never) is the bug being fixed. Retrying more cleverly is not available here:
adding `@octokit/plugin-retry` is explicitly out of scope for #646 and tracked separately.

## Decision

`waitForMerge` bounds sustained failure with three triggers, and any one of them parks the
lane: an error classified as permanent, `MERGE_CHECK_MAX_CONSECUTIVE_FAILURES` (10)
consecutive failed merged-state checks, or `MERGE_CHECK_FAILURE_BUDGET_MS` (2 hours) of
continuous failure measured from the first failure of the current streak. Any successful
merged-state check resets both the counter and the window, so only _sustained_ failure
escalates — an isolated failure keeps its existing "treat as not merged, warn, poll again"
behavior.

The count is the primary trigger at the shipped 120-second cadence (10 failures ≈ 20 minutes);
the wall-clock budget is the backstop that keeps the guard meaningful if the poll interval
ever grows. Both are kept rather than collapsing to one, because neither alone stays correct
under a changed cadence.

`isPermanentMergeCheckError` classifies HTTP 401 as permanent unconditionally, and 403 as
permanent _only_ when the error carries no rate-limit evidence — no `x-ratelimit-remaining: 0`
header, no `retry-after` header, and no rate-limit wording in the message. A rate-limited 403
is transient and only counts toward the streak. Every other error, including a bare network
failure, is transient.

Parking means emitting exactly one `escalate` event that names the branch, which trigger
fired, and the underlying error detail, then throwing `LaneParkError(msg, 'escalate')`.
`runLane` already converts that into a `parked` event and stops the lane, so this reuses the
existing per-lane parking mechanism; `waitForMerge` deliberately does not write `paths.stop`,
which would halt every lane and the supervise loop.

## Consequences

A lane whose GitHub credential dies now surfaces within roughly twenty minutes as an
`escalate` + `parked` pair naming the 401, instead of hanging silently until a human
intervenes; the failure becomes visible to the TUI, the KPI event stream, and notifications
like every other park.

The costs accepted: an outage of GitHub's PR-list API longer than the budget parks a lane that
would eventually have recovered, and the operator must re-run or `factory resume-approved`
that issue. The 401/403 split is a heuristic over error shape — a future GitHub change to how
rate limits are signalled could make a rate-limited 403 look permanent and park early, so the
classifier's evidence checks must be revisited if that shape changes rather than simplified
away. `waitForMerge` gains a throwing path it did not have before; any future caller must
handle `LaneParkError` the way `runLane` does.

This decision is about _when to give up_, and stays orthogonal to the retry policy for
transient Octokit errors: adopting `@octokit/plugin-retry` later would reduce how often the
streak advances without changing any threshold here.

## References

- [Issue #646 — waitForMerge polls forever on permanent errors (expired token)](https://github.com/on-par/software-factory/issues/646)
- [ADR-0014 — the CI merge gate fails closed on non-allow-listed check conclusions](https://github.com/on-par/software-factory/blob/main/docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
