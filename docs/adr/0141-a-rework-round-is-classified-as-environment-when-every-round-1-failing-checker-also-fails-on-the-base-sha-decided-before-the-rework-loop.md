# ADR-0141: A rework round is classified as environment when every round-1 failing checker also fails on the base SHA, decided before the rework loop

- Status: Accepted
- Date: 2026-10-03

## Context

CHECK labeled every rework round that was neither steering nor a provider failure as
'factory-fault', and computed the label after reworkWorker had already run. That hid lanes
blocked by a broken main or environment and left no pre-loop signal for later slices of #1907
(skip, release or pause on an environment failure). Since #1925 CHECK runs the round-1
failing checkers on the base SHA once, before the loop, so the evidence exists before any
rework spend.

## Decision

`ReworkCause` gains `'environment'`. `isEnvironmentFailure` in
`packages/core/src/phases/check.ts` is the single owner of the rule. It returns true only
when the baseline report exists, has no `error`, the round-1 summary has at least one FAIL,
and every FAIL checker has a baseline comparison with verdict `fails-on-base`. A `not-run`
verdict, a missing comparison or any `clean-on-base` checker makes it false. checkPhase
evaluates it once, before the cross-run held check and the rework loop. When it is true,
every `rework` event in that run carries `cause: 'environment'`, which takes precedence over
`direction-change` and `external`. Otherwise `classifyReworkCause` decides as before. The
`held` and `stuck` events keep `factory-fault`. The cause does not change control flow yet.

## Consequences

Rework metrics can now separate environment breakage from lane faults, and a later slice can
act on a cause that is already known before the loop. A round with steering or a provider
failure on a broken base is reported as environment, so that signal is visible only in the
`steering_applied` and failover events. Partial overlap is still reported under the old
heuristic. Consumers that switch on ReworkCause must handle the fourth value.

## References

- [Issue #1927](https://github.com/on-par/software-factory/issues/1927)
- [Parent issue #1907](https://github.com/on-par/software-factory/issues/1907)
