# ADR-0142: Rework drops checkers that also fail on the base SHA from its prompt and failure signature on partial overlap, unless they name new failing tests

- Status: Accepted
- Date: 2026-10-03

## Context

CHECK re-runs the round-1 failing checkers on the base SHA (ADR-0140) and skips rework only
when every failing checker fails there (ADR-0141). On partial overlap, rework still ran
with every failure in its prompt. The failure signature that drives in-run stuck
detection, the cross-run held check (ReworkHistory) and the lane breaker (ADR-0139) also
included failures that no lane change can fix. The rework budget went to base breakage,
and the stuck signals were keyed on failures the lane does not own. Two traps needed
closing. A checker can fail on base while the lane still adds new failing tests to it.
An empty signature would match an empty prior signature and is treated as a reset by
the lane breaker.

## Decision

`checkPhase` (packages/core/src/phases/check.ts) computes the base-failing set once from
the pre-loop baseline with `baseFailingCheckers`. A checker is in the set only when its
comparison verdict is `fails-on-base` and it has no non-empty `newFailingTests`. The set
is empty when the baseline is missing or has an `error`. The rework prompt receives
`excludeBaseFailing(summary, set)`. `stuckSignature(summary, set)` is the single owner of
the signature used for the in-loop no-progress check, the cross-run held check and
`CheckPhaseResult.failureSignature`. The cross-run held check also accepts the full signature so
older unfiltered records still match. It falls back to the full `failureSignature` when
the filter leaves no failures, so a failing CHECK never gets an empty signature. When a
rework round leaves only base-failing checkers failing, the loop stops and the issue
parks. The worker_output park and the all-fail-on-base environment path keep the full
signature.

## Consequences

Rework rounds target only failures the lane can fix, and stuck and held detection follow
the lane's own failures. When there is no overlap, signatures are byte-identical to
before. On partial overlap the persisted signature changes. Older unfiltered records stay matchable
because the held check also accepts the full signature. A checker that is red on base hides any new failures
inside it unless they show up as new failing test names. Output the test-name extractor
cannot parse is treated as base-only.

## References

- [ADR-0141: environment rework cause](docs/adr/0141-a-rework-round-is-classified-as-environment-when-every-round-1-failing-checker-also-fails-on-the-base-sha-decided-before-the-rework-loop.md)
- [ADR-0139: lane breaker on failure signature](docs/adr/0139-a-lane-pauses-after-consecutive-parks-with-the-same-failure-signature-and-pausing-only-stops-claiming.md)
- [Issue #1929](https://github.com/on-par/software-factory/issues/1929)
