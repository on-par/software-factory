# ADR-0028: A SHIP push whose success the PR depends on is verified, never best-effort

- Status: Accepted
- Date: 2026-08-19

## Context

`shipPhase`'s recovery path wrapped `git push -u origin <branch>` in a catch that logged
"trying to continue" and then created the pull request anyway. That is a fail-open gate on
the one fact the PR depends on: that the remote branch head contains this run's commits.
When the push was rejected — non-fast-forward, auth, or network — the factory opened a PR
against a stale or missing remote head, posted an evidence pack describing work that was
not there, marked it ready for review, and returned a success outcome. Nothing downstream
could tell that run apart from a real ship.

The repo already fails closed on the sibling gate: ADR-0014 makes the CI merge gate treat
every conclusion outside an explicit allow-list as failure, precisely so an unknown state
is never read as a pass. The push site is the same shape of decision — an unverified
precondition for an outward-facing, hard-to-retract action (an opened PR).

The counter-pressure is real and is why it was written this way: parking a lane costs a
human re-run, and some push failures are transient. But a parked lane with the branch still
committed in its worktree is recoverable, while a PR opened against the wrong head is
misleading to every reviewer who sees it, and its evidence pack is simply false.

## Decision

SHIP fails closed at any git push whose success a subsequent PR creation depends on. When
that push is rejected, `shipPhase` logs the classified failure and git's own stderr detail
(#733) and returns a non-success `ShipResult` — `{ ok: false }` — before creating or
updating a pull request, posting an evidence pack, marking a PR ready, or emitting the
`ready` event. Callers park the lane on that result, which both existing callers
(`packages/cli/src/cli/index.ts` and `packages/core/src/sim/pipeline.ts`) already do.

Failing closed here means aborting, not retrying: SHIP adds no retry or backoff around the
push. Recovery is a re-run of the lane, which re-enters the same recovery path with the
branch's commits still present in the worktree.

A push that does not gate a PR — the ADR top-up push onto an already-open PR — is a
different decision and is not covered by this ADR.

## Consequences

Positive: no PR is ever opened against a remote head that does not contain the run's
commits; a lane that could not reach the remote reports failure rather than success; the
`ready` event and the evidence pack become trustworthy signals that the work is on the
remote. The failure is diagnosable at the point of abort because the log line carries the
push failure kind and git's stderr (#733).

Negative: transient push failures (a flaky network, a momentary auth blip) now park a lane
that would previously have limped to a PR, so operators will see more parked lanes and must
re-run them. Five existing tests that pinned the continue-anyway behavior are inverted, and
any future "just push best-effort here" convenience at a PR-gating site now contradicts a
recorded decision rather than merely a code comment.

## References

- [Issue #734 — fix: abort PR creation when the SHIP main-branch push fails](https://github.com/on-par/software-factory/issues/734)
- [Epic #640 — SHIP verifies git pushes before opening a PR](https://github.com/on-par/software-factory/issues/640)
- [ADR-0014 — The CI merge gate fails closed on any conclusion outside the passing allow-list](https://github.com/on-par/software-factory/blob/main/docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
