# ADR-0076: The factoryd single-instance guard is a fail-fast pid file, not the fenced file lock

- Status: Accepted
- Date: 2026-09-02

## Context

ADR-0009 defines the repo's cross-process file lock: waiters poll for up to a
timeout and steal a stale lock through a fenced sibling-directory arbiter.
factoryd (#1177) needs a single-instance guard for a long-running daemon, and a
reader would reasonably expect it to reuse that lock. But the two primitives
want opposite semantics: a lock protects a bounded critical section, so waiting
and grace-window steals are correct; a daemon guard protects a process
lifetime, so a second start must fail immediately and loudly, and "held for
hours" is the healthy state, not a staleness signal. The guard must also
survive SIGKILL without ever blocking the next clean start (issue #1177
acceptance criterion).

## Decision

factoryd owns a dedicated pid-file protocol in
`packages/core/src/daemon/runtime-state.ts`. `acquirePidFile` never waits: if
`daemon.pid` names a live pid (`kill(pid, 0)` succeeding or failing with
EPERM, mirroring lock.ts), acquisition fails fast and the caller exits with the
holder pid; if the pid is dead, or the file is missing or unparsable, the file
is stale and is overwritten in place — no arbiter, no grace window.
`releaseRuntimeFiles` removes `daemon.pid` and `daemon.port` only when the pid
file still records the caller's own pid. `daemon.pid`, `daemon.port`, and
`daemon.log` live in the same directory as the registry file (`~/.factory` by
default), so one path — the registry location — anchors all daemon state; this
user-scoped state is deliberately disjoint from per-repo `.factory/` state used
by `factory run`.

## Consequences

A SIGKILLed daemon leaves files behind but never an effective lock: the next
start observes the dead pid and proceeds, which is the whole point. Accepted
risks: pid reuse can make a stale file look live (mitigated only by
loopback-port bind exclusivity failing the impostor scenario's second listener,
and by the operator-visible "already running (pid N)" message naming a
checkable pid); two daemons racing acquisition have no arbiter, but the
exclusive port bind serializes the outcome. Later slices (status/stop verbs,
launchd) MUST read `daemon.port`/`daemon.pid` from `dirname(registry)` and
must not introduce a second state root.

## References

- Issue #1177 (factoryd runtime state), epic #764
- ADR-0009 (fenced steal of stale file locks — the deliberately-not-reused primitive)
- `packages/core/src/daemon/runtime-state.ts`
