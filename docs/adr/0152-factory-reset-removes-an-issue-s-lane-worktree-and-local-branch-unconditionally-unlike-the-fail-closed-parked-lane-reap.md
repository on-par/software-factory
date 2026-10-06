# ADR-0152: factory reset removes an issue's lane worktree and local branch unconditionally, unlike the fail-closed parked-lane reap

- Status: Superseded (by the ADR recorded for issue #1789: reset keeps dirty or unpushed worktrees and branches unless --force)
- Date: 2026-10-01

## Context

`reapLaneWorktree` (#1007) removes a parked lane's worktree fail-closed. It keeps a worktree with modified tracked files and a local branch whose content is not on the remote, because it runs automatically and an unpushed parked attempt may be the only copy of that work. `factory reset <issue>` (#1787) is different. A human runs it to say "throw this attempt away and start over". A failed run almost always leaves a dirty tree and an unpushed branch, so fail-closed rules would leave reset doing nothing useful. The next run's `setupWorktree` already runs `git worktree remove --force` and `git branch -D` on the lane branch, so keeping them protects nothing.

## Decision

`factory reset` removes every git worktree whose branch maps to the issue through `factoryBranchIssue` (resolved prefix or legacy `ship-it`) with `git worktree remove --force` via `cleanupWorktree`. It deletes every matching local branch with `git branch -D`, whatever its dirty or pushed state. It has no force flag. Its only built-in exclusions are the main checkout and the worktree containing the process's cwd; a branch checked out in either is reported as kept. Remote branches, labels, PRs, `events.ndjson` and `costs.jsonl` are never touched. Automatic reaping paths (`reapLaneWorktree`, `sweepWorktrees`) stay fail-closed.

## Consequences

One command leaves an issue ready for a fresh run, with nothing stale left to confuse PLAN, CHECK's cross-run stuck detection or the lane guards. Uncommitted or unpushed work in that issue's lane is lost with no prompt. Any future automatic caller must not reuse reset's removal path and must go through `reapLaneWorktree` or `sweepWorktrees`.

References: ADR-0118, issue #1787.
