# ADR-0116: A contained review owns container teardown on every exit path, including SIGINT/SIGTERM

- Status: Accepted
- Date: 2026-09-29

## Context

A contained fork-PR review (ADR-0114, ADR-0115) creates a disposable container holding untrusted
code and starts it with a long-lived `tail -f /dev/null`. `factory doctor --reconcile` only reaps
exited/dead `sf-job-*` containers, so a review that exits without removing its container leaves
running untrusted code behind that nothing collects. The review had no teardown at all: success,
error and interrupt all leaked. There is no single CLI caller yet (fork routing is a separate
story), so a guarantee placed in a caller would not protect future callers.

## Decision

`runContainedReview` is the single owner of its container's lifetime. It refuses before
provisioning when the `ContainerEngine` lacks the optional `removeLaneContainer` port — an engine
that cannot tear a lane container down cannot contain a fork review. It derives the container name
up front, runs provisioning and checkers inside try/finally that calls one memoized, never-throwing
teardown, and for the duration of the call registers SIGINT and SIGTERM listeners (through an
injectable `ReviewInterruptSource`, defaulting to `process`) that await that same teardown and then
exit with 130 / 143. Listeners are always detached before it returns. A teardown that fails is
reported in the result's `teardown` proof, not thrown; the existing reconcile path remains the
backstop.

## Consequences

Every caller of `runContainedReview` inherits teardown on success, error and interrupt with no
extra code. Callers must not install their own competing SIGINT/SIGTERM handlers that exit before
the review's teardown resolves, and must accept that an interrupt during a review ends the process
after teardown. Every `ContainerEngine` used for fork reviews must implement `removeLaneContainer`,
or fork reviews are refused. A `docker rm -f` failure can still leave a running container that
reconcile does not reap today; that gap is recorded, not closed here.

## References

- Issue #1686 — Guarantee review container teardown on every exit path
- ADR-0115 — contained review runs a container-side command-checker set
