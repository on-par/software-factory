# ADR-0075: After a green CHECK, SHIP commits the verified working tree instead of parking on dirt

- Status: Accepted
- Date: 2026-09-02

## Context

CHECK runs the verification gate against the lane worktree's working tree, not
against a commit — so when a build agent leaves output uncommitted (as on #1164),
the dirty tree is byte-for-byte the artifact that went green. SHIP's recovery
path nevertheless refused any dirty worktree ("worktree has uncommitted
changes") and parked the lane, burning a parked ticket on verified work and
forcing a human to hand-commit and open the PR. The issue left auto-commit vs.
recover-only negotiable; blindly committing everything is also wrong, because a
tree with unmerged entries would commit conflict markers onto the PR branch.

## Decision

SHIP owns the last-mile commit. When the recovery path finds a dirty worktree
after CHECK passed, it commits all non-ignored dirt (tracked and untracked, with
the same pathspec exclusions the dirty-check already applies to failed ADR
materialization) onto the ship-it branch and continues to push/PR. Dirt is
unshippable only when git porcelain reports unmerged entries (X or Y of U, AA,
DD) or when git itself refuses the add/commit; those cases park with a reason
naming the conflicted paths or git's own error text, and the worktree is
preserved for a human.

## Consequences

Positive: a green check can no longer strand its own output — the verified tree
is what ships, and build agents forgetting to commit is downgraded from a parked
ticket to a logged auto-commit. Park reasons for the genuinely-unsafe cases are
concrete and actionable. Negative: SHIP now creates commits authored by the
factory that the build agent never made, so a PR branch's history can contain a
trailing "commit build output left after check" commit; and any file the build
agent scattered that is not gitignored will reach the PR — the gitignore, not
SHIP, is the boundary for what counts as build residue.

## References

- [Issue #1172](https://github.com/patrob/software-factory/issues/1172)
- [Issue #1172](https://github.com/on-par/software-factory/issues/1172)
