# ADR-0114: A fork PR review is fail-closed on containment and never falls back to the host

- Status: Accepted
- Date: 2026-09-29

## Context

`factory review <pr>` (epic #1667) runs the compile and tests checkers, which execute the PR
author's code. For a PR whose head repository differs from its base repository, that code is
untrusted, and running it on the operator's host is a security exposure. Disposable-docker
containment exists (`ContainerEngine`, `provisionLaneContainer`), but a contained review
runner is a later story (#1685), and Docker may simply not be running on an operator's
machine. Several states are ambiguous: an engine with no availability probe, a probe that
errors, a PR whose head repository was deleted, and Docker being up with no contained runner
yet. Any of these, resolved permissively, would run fork code on the host.

## Decision

`packages/core/src/review/containment.ts` is the single gate every review passes through
before any checkout or checker. `isForkPullRequest` classifies a PR as a fork when its head
repository differs from its base repository (case-insensitive `owner/name`) or when the head
repository is unknown. For a fork, `resolveReviewContainment` probes Docker only through the
`ContainerEngine.isAvailable` port. A missing probe, a `false` result, or a thrown error all
mean "unavailable". `runContainmentGatedReview` calls the host runner only for same-repo PRs.
A fork PR is either handed to an injected contained runner or refused with a message stating
that containment is required and exit code 2 (`REVIEW_CONTAINMENT_REFUSED_EXIT_CODE`). This
includes the case where Docker is up but no contained runner is wired. No code path falls
back from a fork PR to host execution.

## Consequences

Fork code cannot reach the host through the review path by construction. Every ambiguous
state refuses, and the refusal is a distinct, scriptable exit code (2) separate from a failed
review. Same-repo reviews never probe Docker, so they are unaffected when Docker is absent.
The cost is that operators without Docker cannot review fork PRs at all. Until #1685 supplies
a contained runner, fork PRs are refused even when Docker is running. Future review code
must route through `runContainmentGatedReview` rather than checking out a PR head directly,
and a new ContainerEngine adapter must implement `isAvailable` or its fork reviews will
always be refused.

## References

- [Issue #1684 — Refuse fork PR reviews when containment is unavailable](https://github.com/on-par/software-factory/issues/1684)
- [Epic #1667 — Standalone PR review](https://github.com/on-par/software-factory/issues/1667)
