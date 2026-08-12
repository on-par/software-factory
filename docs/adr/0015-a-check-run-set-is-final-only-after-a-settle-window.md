# ADR-0015: A check-run set is final only after a settle window or a caller-declared minimum count

- Status: Accepted
- Date: 2026-08-12

## Context

`watchChecks` (`packages/core/src/utils/ci-watch.ts`) is the single gate that decides whether
a factory-produced PR is green enough to merge. ADR-0014 hardened *which conclusions* count
as passing, but left untouched the prior question of *when the set of check runs is complete*.

GitHub's check-run list for a ref is not a fixed roster that fills in — it grows as workflows
register. A workflow that starts late, is queued behind a concurrency group, or is triggered
by a second push contributes no check run at all until it registers one. The original
completeness test — every check run that currently exists has `status === 'completed'` — is
therefore satisfied by a set of one: a lint job that registered and finished inside the
watcher's first poll interval, before the integration suite existed. The watcher reported
'success', `shipPhase` logged "CI green", and `landOpenPullRequest` merged a PR whose
required checks had not run (issues #596, #602).

The generalisable force is that absence of evidence arrives before evidence of absence: a
snapshot of a growing set cannot be distinguished from a snapshot of a finished set by
looking at that snapshot alone. Only a second look — separated by time, or checked against an
externally declared expected size — can tell them apart. Any fix therefore has to spend
something (latency, or caller knowledge), which is exactly the kind of cost a later reader
is tempted to "optimise away" by restoring the single-snapshot test.

## Decision

A complete check-run set is treated as final only when one of two conditions holds, and
`watchChecks` returns `'success'` only then.

`WatchChecksOptions` gains `settleMs` (default `30_000`) and an optional `minChecks`. The
poll loop records the observed check-run count and the time that count was first observed;
any change to the count restarts that window. When the caller declares `minChecks`, a
complete all-passing set of at least that many runs is final immediately — the caller's
knowledge of the repo's required checks outranks the clock — and a set smaller than
`minChecks` is never final, so an over-stated minimum ends the watch as `'timeout'` rather
than as a merge. When no `minChecks` is declared, the set is final once its count has been
unchanged for `settleMs`.

The settle window gates only the `'success'` exit. A complete set containing a conclusion
outside `PASSING_CONCLUSIONS` returns `'failure'` on the poll that observes it, with no
settle delay and regardless of `minChecks`: a check run that appears later cannot turn a red
check green, so delaying a red verdict buys nothing. The deadline and poll-error exits
continue to return `'timeout'`, never `'success'`.

Callers may set `settleMs: 0` to restore first-poll completion, and tests that drive the
watcher for reasons other than exercising it are expected to inject a stub `watch` rather
than to shorten the default.

## Consequences

Positive: a green verdict now rests on a check-run set that was observed twice, at least
`settleMs` apart, so a workflow that registers late is waited for and its conclusion counted.
The fix is a property of the watcher rather than of its callers, so `shipPhase` and
`landOpenPullRequest` are protected without knowing anything about the repo's workflows.
`minChecks` gives a caller that does know its required checks a way to buy the latency back
while being strictly stricter, not looser.

Negative: every ship pays up to one extra poll of wall-clock (~15–45s with the default
backoff) before CI is declared green, and the settle window is measured in time rather than
in facts — it is a heuristic, and a workflow that registers more than `settleMs` after the
previous check completed can still be missed when no `minChecks` is supplied. If `settleMs`
were ever configured near `deadlineMs`, a genuinely green run would end as `'timeout'`; that
fails in the safe direction but is a real foot-gun. Tests that exercise the real watcher must
now advance a clock or stub it out, which is why several land tests in
`packages/cli/src/cli.test.ts` inject `watch` instead of driving the real function.

## References

- [Issue #602 — ci-watch: a partial check-run set can be read as a complete green run](https://github.com/on-par/software-factory/issues/602)
- [Issue #596 — the bundled ci-watch fix this issue was split out of](https://github.com/on-par/software-factory/issues/596)
- [ADR-0014 — The CI merge gate fails closed on any conclusion outside the passing allow-list](https://github.com/on-par/software-factory/blob/main/docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
- [GitHub REST API — list check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
