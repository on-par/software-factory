# ADR-0037: The land locks cover git mutations only, and state observed unlocked is re-read inside the lock

- Status: Accepted
- Date: 2026-08-19

## Context

`landIssue` used to hold both the process-wide `withGitLock(repoRoot, ...)` chain and the
cross-process `withFileLock(paths.mergeLock, ...)` for the whole land sequence. Most of
that sequence is waiting rather than mutating: `watchChecks` has a 10-minute deadline, the
DIRTY path watches CI a second time after rebasing, and merge retries add up to 75s of
backoff. Since every lane's `setupWorktree` and the worktree GC use the same `repoRoot`
git-lock key, a single landing lane serialized the whole factory for 10-20 minutes, and a
cross-process waiter on the merge lock — which under ADR-0009 must never steal a live
holder's lock — hit the 30-minute stuck-lock timeout and parked its lane. Shortening the
CI watch and loosening the lock were both rejected: the watch is the merge gate ADR-0014
and ADR-0015 depend on, and the steal policy is deliberately conservative. The remaining
lever is hold time. Holding a lock for less time, however, means a PR state read while
unlocked can be stale by the time the lock is acquired — a sibling lane may have merged,
rebased, or dirtied the PR in between.

## Decision

The land locks protect git mutations, nothing else. `landOpenPullRequest` takes an injected
`LandLock` (`<T>(fn: () => Promise<T>) => Promise<T>`, identity by default) and acquires it
around exactly three kinds of critical section: the DIRTY-path rebase + force-push, a single
merge attempt (draft-ready flip + `squashMergeAndDelete`), and — in `landIssue` — worktree
cleanup. `watchChecks`, the `getPullRequestLandState` probes that drive the DIRTY decision,
and the merge-retry backoff sleep all run with no lock held. Every critical section re-reads
`getPullRequestLandState` as its first statement and decides from that read, never from a
verdict gathered outside the lock: a PR that is no longer DIRTY when the lock is acquired is
not rebased. `landIssue` owns lock composition — it builds one `withLandLock` closure over
`withGitLock(repoRoot, ...)` and `withFileLock(paths.mergeLock, ...)` and injects it — so
`landOpenPullRequest` stays lock-implementation agnostic and directly testable.

## Consequences

Positive: a lane's CI watch no longer occupies the process-wide git-lock chain, so sibling
lanes create worktrees and start issues while a lane lands; merge-lock hold time drops from
10-20 minutes to the duration of a rebase or a merge call, so cross-process waiters stop
hitting the 30-minute stuck-lock timeout; the lock seam is injectable, so lock scoping is
unit-testable without real locks.
Negative: each critical section costs an extra `getPullRequestLandState` GraphQL round-trip
(the CLEAN path now reads state twice), and the land sequence is no longer atomic — a
sibling lane can change the PR between the CI watch and the merge. That is accepted
deliberately: the merge itself is still serialized and still gated on a green watch, and the
in-lock re-read is the mechanism that makes acting on a stale verdict impossible. Any future
step added to the land sequence must decide explicitly whether it is a mutation (inside a
critical section, after a state re-read) or a wait (outside every lock).

## References

- [Issue #645 — landIssue holds the process-wide git lock across a 10-20 minute CI watch](https://github.com/on-par/software-factory/issues/645)
- [ADR-0009 — Stealing a stale file lock is fenced by a sibling steal-arbiter directory](docs/adr/0009-fenced-steal-of-stale-file-locks.md)
