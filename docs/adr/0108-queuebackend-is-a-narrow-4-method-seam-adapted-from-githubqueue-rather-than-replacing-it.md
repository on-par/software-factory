# ADR-0108: QueueBackend is a narrow 4-method seam, adapted from GithubQueue rather than replacing it

- Status: Accepted
- Date: 2026-09-15

## Context

Issue #1499 asks for a `QueueBackend` interface (`claimNext`/`release`/`list`/`reap`)
so a future Linear/Jira/Project-board backend has a contract to implement, while
GitHub Issues stays the only implementation today. The existing `GithubQueue` type
(packages/core/src/queue/github-queue.ts) already exposes `claimNext`/`release`/`list`,
but `list` takes a required `lane: string`, there is no `reap()` member (stale-claim
release lives as a standalone `releaseStaleClaims` function in stale-claims.ts, which
itself calls `createGithubQueue` to perform its release), and `GithubQueue` carries two
more members (`lanes()`, `migrateLocalQueue()`, `enqueue()`) that
`packages/cli/src/cli/index.ts` depends on and that have no place in a
backend-agnostic seam. Widening `GithubQueue.list` in place and adding `reap()`
directly to it would (a) risk changing the type CLI already depends on and (b) require
github-queue.ts to import from stale-claims.ts, which already imports from
github-queue.ts — a module-level circular dependency between the two files.

## Decision

`QueueBackend` is defined in a new file, `packages/core/src/queue/queue-backend.ts`,
with exactly four members: `claimNext(lane)`, `release(issue, outcome?)`,
`list(lane?)`, `reap()`. `createGithubQueueBackend(options)` in the same file adapts
the existing, unmodified `createGithubQueue(options)` and `releaseStaleClaims(...)`
into one object satisfying `QueueBackend`, without changing either of those two
functions or the `GithubQueue` type they already produce/consume. `list(lane?)`
without a lane fans out across `GithubQueue.lanes()` (lane-sorted) and concatenates
each lane's already-ordered issue numbers. Any future backend (Linear, Jira, Project
boards) implements `QueueBackend` directly — it does not need, and must not be made
to need, the wider `GithubQueue` surface.

## Consequences

Positive: zero behavior change to the existing, well-tested GitHub-labels code path;
no circular import; CLI's dependency on the wider `GithubQueue` type is completely
unaffected; a future backend has a small, honest contract to implement. Negative: two
related but distinct types now exist for the GitHub queue (`GithubQueue` and
`QueueBackend`), and callers that want the seam's `reap()`/optional-lane `list()` must
construct a `createGithubQueueBackend(...)` alongside (or instead of)
`createGithubQueue(...)` rather than getting both from one factory — wiring any real
caller to the new seam is left to a follow-up issue.
