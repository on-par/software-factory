# ADR-0027: Worktree GC sources merge/close evidence from the GitHub API; local git state is only a fallback

- Status: Accepted
- Date: 2026-08-14

## Context

#639 made worktree GC require prior-push evidence before deleting a 'merged' or
'remote-gone' worktree, sourcing that evidence from local git state: the
remote-tracking ref, its reflog, and branch.<name>.merge. All three are routinely
absent by GC time in this factory: GitHub's delete_branch_on_merge removes the
upstream branch, nothing locally re-fetches the tracking ref afterwards, and the
SHIP phase's plain-push call site (`git push origin`, no -u) never rewrote
branch.<name>.merge. A fully merged, clean worktree therefore could not ever prove
itself safe, merged worktrees accumulated without bound ("removed 0, kept 13"
trending upward while 13 PRs merged the same day), and the host disk hit ~1.4GB
free twice in three days (#713). The forces in tension: over-deletion destroys the
only copy of uncommitted work (what #639 fixed), while under-deletion silently
fills the disk; any evidence source tied to local fetch/prune timing or to which
push code path a ship happened to take will drift back toward one of those poles.

## Decision

sweepWorktrees accepts an injected octokit client and repo slug, and asks GitHub —
the system that actually decides whether a branch's work landed — for each
candidate branch's PR state via one pulls.list(state=all, head=owner:branch) query
per branch per sweep. An open PR always keeps the worktree. A merged PR is
authoritative for removal on its own, with no local push-evidence or ancestry
requirement. A closed-not-merged PR removes only with corroboration (HEAD is an
ancestor of origin/main, or the remote branch is gone). No PR, a failed query, or
an absent client/repo yields no verdict, and classification falls back to the #639
local-evidence rules unchanged. A tracked-file cleanliness guard
(git status --porcelain --untracked-files=no) additionally blocks every
merged/remote-gone removal; every inconclusive probe — GitHub or local — still
means keep. SHIP's two push call sites are unified on `git push -u` so the local
fallback evidence no longer depends on which path executed.

## Consequences

Merged worktrees are reclaimed again even after upstream branch deletion and local
ref pruning, ending the unbounded kept-count growth. The sweep gains a network
dependency: it costs up to one GitHub API call per candidate worktree and, when
GitHub is unreachable or the repo has no token, silently degrades to the
local-evidence rules — i.e. to today's over-keeping behavior, never to
over-deletion. Future changes must preserve the fallback ordering (GitHub verdict
first, local rules only when there is no verdict) and must not re-derive merge
status from local refs alone; the ttl-expired backstop deliberately remains the
only rule that removes without merge evidence.

## References

- [Issue #713: hasPriorPushEvidence gate never fires for the plain-push SHIP path](https://github.com/patrob/software-factory/issues/713)
- [Issue #713](https://github.com/on-par/software-factory/issues/713)
