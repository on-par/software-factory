# ADR-0072: Worktree bases come from a fresh fetch enforced inside setupWorktree, never from local branch state

- Status: Accepted
- Date: 2026-09-02

## Context

The SlopCodeBench push showed that a factory lane created while local
`main` was stale/dirty/ahead silently builds and benchmarks against the
wrong base. The `git fetch` before worktree creation used to be a caller
convention — only the CLI's injected setup lambda performed it — so any
other path through `worktreeWorkspace`/`setupWorktree` could cut a lane
from a stale remote-tracking ref with no record of which commit the lane
actually started from.

## Decision

`setupWorktree` owns the freshness invariant. It unconditionally runs
`git fetch origin -q --prune` before `git worktree add`, resolves an
omitted start point to the repo default branch's remote-tracking ref
(via `refs/remotes/origin/HEAD`, falling back to `origin/main`), treats
an explicitly supplied start point as authoritative (the resume/land
path), and emits a `worktree-base` event recording the base ref and
resolved commit SHA for every worktree it creates. Callers must not
re-introduce their own pre-fetch or derive a worktree base from a local
branch.

## Consequences

Positive: every lane provably starts from the current remote base, the
base SHA is auditable in `.factory/events.ndjson`, and new callers get
the invariant for free. Negative: worktree creation now hard-requires a
reachable origin (an offline run fails at setup — it already did via the
CLI's pre-fetch), each resumed-land worktree performs one extra fetch,
and `--prune` removes stale remote-tracking refs as a side effect.

## References

- [Issue #1167](https://github.com/on-par/software-factory/issues/1167)
