# ADR-0014: The CI merge gate fails closed on any conclusion outside the passing allow-list

- Status: Accepted
- Date: 2026-08-12

## Context

`watchChecks` (`packages/core/src/utils/ci-watch.ts`) is the single gate that decides
whether a factory-produced PR is green enough to merge: `shipPhase` awaits it before
merging, and the CLI's watch handler turns its verdict into a confirmed-CI-failure error.

Its original implementation asked one question — `conclusion === 'failure'` — and treated
everything else as passing. GitHub's check-run API emits far more terminal conclusions than
that: `cancelled`, `timed_out`, `action_required`, `stale`, `startup_failure`, and `null`
on a run that completed without recording one. Under a deny-list of exactly one value, a
required check that was cancelled by a concurrency group, timed out, or never started was
reported to the caller as `success`, and the factory merged a PR whose CI had not actually
passed (issues #596, #638, #601). GitHub itself accepts only `success`, `neutral`, and
`skipped` as satisfying a required status check, so the deny-list was strictly more
permissive than the platform it was modelling.

The generalisable force is that this list grows on GitHub's schedule, not ours. Any
enumeration of _bad_ conclusions is wrong the moment GitHub adds a new one, and it fails in
the dangerous direction — an unrecognised conclusion reads as green. An enumeration of
_good_ conclusions fails in the safe direction: a new conclusion blocks the merge until a
human decides it is benign. This is a merge-safety decision, but from the code alone the
allow-list looks like an incomplete deny-list, and the safe reading is easy to "simplify"
back into the unsafe one — which is exactly why it needs to be written down.

## Decision

The CI merge gate fails closed. `packages/core/src/utils/ci-watch.ts` defines
`PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])` — mirroring the three
conclusions GitHub itself accepts for a required status check, with `skipped` present
because it is the normal result of a path-filtered job — and `watchChecks` returns
`'success'` only when every completed check run's conclusion is a member of that set.
Every other value resolves to `'failure'`: the named terminal conclusions (`failure`,
`cancelled`, `timed_out`, `action_required`, `stale`, `startup_failure`), a `null` or
absent conclusion on a completed run, and any conclusion GitHub introduces in the future.

The set is an allow-list and must stay one. Adding a conclusion to it is a deliberate
merge-safety decision that requires a colocated test in
`packages/core/src/utils/ci-watch.test.ts` asserting the new passing behaviour; the
corresponding blocking cases are pinned by name in that file's `it.each` matrix so
widening the set cannot pass silently. No caller is permitted to reinterpret a `'failure'`
outcome as mergeable.

The same fail-closed principle governs the watcher's other two exits and they are
deliberately kept distinct from a pass: an exhausted retry budget or an elapsed deadline
returns `'timeout'` — "no verdict was reached" — and never `'success'`.

## Consequences

Positive: an unrecognised or newly introduced GitHub conclusion blocks the merge instead of
being waved through, so the gate degrades safely as the platform evolves. The rule is stated
once, in one set, and matches GitHub's own definition of a satisfied required check. The
three-way `CiOutcome` keeps "CI failed" distinct from "we never learned", so callers can
treat a flaky watcher differently from a red build.

Negative: the gate is strictly more conservative than a deny-list. A check that is cancelled
for a benign reason — a superseded concurrency-group run, a job cancelled by hand — is
reported as a failure and requires a re-run or human intervention rather than merging on the
strength of the other green checks. That false-positive cost is accepted deliberately: a
blocked merge is recoverable, a merged red PR is not. Widening the allow-list is
correspondingly more ceremonious, requiring a test change and a conscious decision rather
than an edit to a condition.

## References

- [Issue #601 — ci-watch: treat any non-success conclusion as a CI failure, not just failure](https://github.com/on-par/software-factory/issues/601)
- [Issue #638 / PR #680 — CI watcher fails closed on cancelled/timed_out check conclusions](https://github.com/on-par/software-factory/pull/680)
- [GitHub REST API — check runs, conclusion values](https://docs.github.com/en/rest/checks/runs)
