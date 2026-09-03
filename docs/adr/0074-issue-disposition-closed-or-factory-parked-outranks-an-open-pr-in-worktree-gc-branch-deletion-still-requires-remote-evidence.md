# ADR-0074: Issue disposition (closed or factory:parked) outranks an open PR in worktree GC; branch deletion still requires remote evidence

- Status: Accepted
- Date: 2026-09-02

## Context

ADR-0027 made GitHub PR state the primary worktree-GC evidence and ruled
that an open PR always keeps the worktree. That rule assumed an open PR
means in-flight work. Parked lanes broke the assumption: a park after SHIP
leaves an open PR forever (the factory never auto-merges a parked green PR
— out of scope of #1007), and a park before SHIP leaves no PR and no push
evidence, so neither branch of ADR-0027's decision tree could ever reap a
parked lane. One sibling checkout accumulated per parked issue per repo
(fifteen on software-factory alone by 2026-08-28), and autoGcOnRun/
doctor --reconcile were structurally unable to clear them. Meanwhile
factory:parked is a manual gate, so a parked attempt's committed work must
remain inspectable, and ADR-0027's core stance — degrade toward
over-keeping, never over-deletion — still binds.

## Decision

sweepWorktrees consults the owning issue (parsed from the lane branch
`<prefix>/<n>-*`, one memoized issues.get per issue per sweep). A clean
factory worktree whose issue is closed or carries the factory:parked label
is reaped (reasons `issue-closed` / `issue-parked`) even when its branch
has an open PR: a finished or parked issue's open PR proves the work is
pushed, so the local checkout is redundant. The local branch is
force-deleted only with remote evidence — the branch has a PR, the remote
branch exists, or its tip is an ancestor of origin/main; an unpushed
branch always survives as the sole handle to the parked attempt. Lanes
also reap eagerly at park time through the same rules (reapLaneWorktree),
gated additionally on the checked-out branch matching `<prefix>/<issue>-`.
Dirty worktrees (modified tracked files) are never removed by these rules,
and any failed probe — GitHub or local — still means keep. All other
ADR-0027 rules (evidence ordering, local-evidence fallback, ttl backstop)
are unchanged.

## Consequences

Parked and finished issues no longer accumulate sibling checkouts; run
start, park time, and doctor --reconcile all converge on the same
disposition rules. The sweep gains up to one extra GitHub API call per
distinct lane issue. A branch holding an unpushed parked attempt is
deliberately kept, so `git branch` can still show ship-it/<n> branches for
parked issues until they are pushed or a human deletes them — accepted, as
the alternative destroys the only copy of a manually-gated attempt. An
issue closed by a human while a lane is mid-run is a (rare) reap hazard
accepted because the run lock serializes runs and reconcile removals still
require a clean tree.

## References

- [Issue #1007: After park or run-done, remove the lane worktree](https://github.com/on-par/software-factory/issues/1007)
- [ADR-0027: Worktree GC sources merge/close evidence from the GitHub API](https://github.com/on-par/software-factory/blob/main/docs/adr/0027-worktree-gc-sources-merge-close-evidence-from-the-github-api-local-git-state-is-only-a-fallback.md)
