# ADR-0137: SHIP force-pushes a lane branch only under a lease pinned to the remote SHA recorded at worktree creation

- Status: Accepted
- Date: 2026-10-02

## Context

A retry starts the lane branch fresh from origin/main (ADR-0072), but an earlier run may already have pushed the same branch to origin. A plain push is then rejected as non-fast-forward and the run fails, even though the remote head is only stale factory output. #1868 records origin/<branch> at worktree creation so the factory knows what it saw. ADR-0028 requires every push the PR depends on to be verified. An unconditional force push would destroy any commit a human or another run pushed after that record.

## Decision

On SHIP's new-PR path, when a pre-existing remote SHA was recorded at worktree creation, SHIP reads origin/<branch> with `git ls-remote` before pushing. If it still equals the recorded SHA, SHIP pushes with `git push --force-with-lease=<branch>:<recorded sha> -u origin <branch>` and then verifies that the remote head equals local HEAD (ADR-0028). If the remote moved or cannot be read, SHIP does not push and fails closed with a reason naming the recorded and current SHA. When nothing was recorded, SHIP never force-pushes. No other code path in SHIP may force-push, and a bare `--force` is never used.

## Consequences

Retries over a stale factory branch ship without a human deleting the remote branch. Commits pushed after the record are never overwritten. The cost is one extra ls-remote round trip when a record exists, and a park when the remote moved, which a human must resolve. The existing-PR path is still governed by #1795 and never force-pushes.

References: issue #1869, issue #1868.
