# ADR-0115: A contained review runs a container-side command-checker set and reports host-only checkers as SKIP

- Status: Accepted
- Date: 2026-09-29

## Context

Fork PRs must be reviewed without executing untrusted code on the operator's host (ADR-0114),
and the fork code itself should stay out of the operator's working tree. The existing checker
registry (`runAllCheckers`) is host-bound: compile/tests/lint read package.json and probe the
worktree through the host filesystem, the links/accessibility checkers scan files on the host,
and agent custom checkers grade code through a model router on the host. None of them can run
against a checkout that only exists inside a container, and the default lane image has no
factory runtime to run the registry in-container. At the same time the review report and
`computeReviewVerdict` (ADR-0113) must receive the same `CheckSummary` shape for fork and
same-repo PRs.

## Decision

`runContainedReview` (`packages/core/src/review/contained.ts`) provisions a disposable-docker
lane container through `provisionLaneContainer`, populates it with the PR head
(`refs/pull/<n>/head` fetched from the base repo, via the ADR-0112 host-temp-dir-then-docker-cp
path), and runs only the command checkers (compile, tests, lint) inside it through the optional
`ContainerEngine.execInLaneContainer` port. Script selection mirrors the host checkers and is
decided on the host from package.json text read out of the container. links and accessibility
are reported as SKIP with an explicit "not run in a contained review" reason, and custom agent
checkers are not run, so a constitution that requires them caps the verdict at approve with
comments. The summary is built by `summarizeCheckerOutputs`, the same helper `runAllCheckers`
uses, so report parity holds by construction. An engine without `execInLaneContainer` is
treated as unable to contain and the review fails closed.

## Consequences

Fork PRs become reviewable with deterministic checker results that never execute on the host,
and the verdict logic needs no fork-specific branch. The contained checker set is a second,
smaller implementation of command-checker selection that must be kept in step with the host
checkers when their selection rules change. Host-only checkers stay unavailable for fork PRs
until they are ported to run in-container (visible as SKIP reasons, never as a silent PASS).
Lane containers now start with a keep-alive command so they can be exec'd into. The PR head is
still cloned into a host scratch directory (ADR-0112) that is never executed and always
removed; keeping fork bytes off host disk entirely would need a lane image with git and an
amendment to ADR-0112.

## References

- [Issue #1685 — Run fork PR checkers in a disposable container](https://github.com/on-par/software-factory/issues/1685)
- [ADR-0114](0114-a-fork-pr-review-is-fail-closed-on-containment-and-never-falls-back-to-the-host.md)
- [ADR-0112](0112-lane-workspace-clone-goes-host-temp-dir-then-docker-cp-not-exec-or-a-bind-mount.md)
