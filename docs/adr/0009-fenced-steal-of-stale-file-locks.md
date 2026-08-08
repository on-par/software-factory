# ADR-0009: Stealing a stale file lock is fenced by a sibling steal-arbiter directory

- Status: Accepted
- Date: 2026-08-08

## Context

`withFileLock`/`withFileLockSync` (packages/core/src/utils/lock.ts) are the only
cross-process serialization the factory has: the merge lock, the git lock, the
`.factory/ports.json` registry, and the synchronous event-log append all sit behind
them. Acquisition is a single atomic `mkdirSync(lockDir)`, which is correct on its
own. Recovery is not: a process killed mid-critical-section (restart, SIGKILL) leaves
the lock dir behind with a dead pid, and the recovery path read the pid, decided the
holder was dead, and then `rmSync`-ed the dir. That check-then-act is unfenced — two
waiters (typically the launchd sweeper and a lane's own `waitForMerge` waking
together) can both pass the check, and if the first one completes its steal and
re-acquires in the window, the second deletes the first's _live_ lock and acquires it
too. Two processes then run merge/git operations against the same worktree and branch
(#597). POSIX offers no conditional directory replacement that fixes this directly:
`rename` is atomic but unconditional, so its single winner can still rename away a
lock someone already re-acquired, and `renameat2`/`RENAME_EXCHANGE` is Linux-only and
not exposed by `node:fs`. A fencing counter would have to live outside the lock dir
(the dir is deleted on release) and would need its own atomic update — the same
problem one level down. Dropping the steal entirely would wedge the merge lock for the
full 30-minute timeout after any crash, parking every lane.

## Decision

Stealing a stale lock is a two-part protocol, and both parts are mandatory. First, a
waiter captures the stale holder's identity as a single observation — the `pid` file
contents, the lock dir's inode, and its mtime. Second, the check-and-remove runs
inside a critical section arbitrated by an atomically created sibling directory
`${lockDir}.steal`: whoever wins that `mkdir` re-observes the lock and removes it only
if the identity is unchanged; everyone else removes nothing and backs off through the
normal poll/timeout path. The arbiter is released in a `finally`, and an arbiter older
than `graceMs` — the fingerprint of a stealer that died mid-steal — is reaped so a
crash cannot wedge the lock permanently. `onSteal` reports only a steal this process
actually performed. Consequently, `.factory/*.lock` directories are owned by this
protocol: no process, script, or sweeper may delete a stale lock dir directly, because
an unarbitrated delete reintroduces the race for everyone. The lock dir itself keeps
its existing shape (a directory created with `mkdir`, holding a `pid` file, removed on
release only when the pid still matches), so sync and async holders and older on-disk
state stay compatible.

## Consequences

Positive: at most one of any number of concurrent stealers can remove a given stale
lock, and it can only remove the exact lock it observed — so a lock re-acquired
mid-steal is never deleted, and two holders can no longer both believe they hold the
merge or git lock. The losing stealer's backoff still counts toward `timeoutMs`, so
the existing `stuck >30m` / `reason: 'timeout'` contract is unchanged. One shared
synchronous helper serves both the async and sync locks, so the two variants cannot
drift apart.
Negative: the on-disk footprint grows by a transient `${lockDir}.steal` directory that
is visible to anything listing `.factory/`; a stealer killed between creating and
removing it blocks steals for up to `graceMs` (10 s by default) before it is reaped;
each contended poll iteration now costs one extra `statSync`, including on the
synchronous event-logger path; and during a rollout an old process still running the
unfenced steal ignores the arbiter, so the race only fully closes once every process
is on this code. External tooling (the launchd sweeper, ad-hoc cleanup scripts) must
be kept from `rm -rf`-ing live lock dirs.

## References

- [Issue #597 — Lock steal race in withFileLock allows two concurrent holders](https://github.com/on-par/software-factory/issues/597)
- [ADR-0002 — Structured logging via the existing event log (the synchronous lock's hot-path caller)](https://github.com/on-par/software-factory/blob/main/docs/adr/0002-structured-logging-via-event-log.md)
