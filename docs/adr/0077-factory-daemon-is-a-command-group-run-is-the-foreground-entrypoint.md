# ADR-0077: `factory daemon` is a command group; `run` is the foreground entrypoint

- Status: Accepted
- Date: 2026-09-02

## Context

Issue #1177 names `factory daemon run` as the entrypoint, and its declared next
slice adds start|stop|status|logs verbs. The existing `factory daemon` was a
leaf command; adding verbs later would force a breaking restructure of a
command that by then might be embedded in launchd plists and operator muscle
memory.

## Decision

`factory daemon` becomes a commander command group (mirroring `factory
worktree`), and the foreground process moves to `factory daemon run` now,
before any external supervisor references the command line. Future daemon
verbs are siblings of `run` under the same group.

## Consequences

The launchd plist slice can pin `factory daemon run` as a stable
ProgramArguments value. The old bare `factory daemon` spelling stops starting
the daemon and prints the group's help instead — a one-time break while the
only caller is our own test suite.

## References

- Issue #1177 (factoryd runtime state), epic #764
- `packages/cli/src/cli/index.ts` (`cmdFactoryd`, daemon command group)
- `docs/runbooks/factoryd.md`
