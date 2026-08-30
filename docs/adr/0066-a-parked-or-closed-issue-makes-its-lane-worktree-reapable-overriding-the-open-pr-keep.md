# ADR-0066: A parked or closed issue makes its lane worktree reapable, overriding the open-PR keep

- Status: Accepted
- Date: 2026-08-29

## Context

`sweepWorktrees` treats an open pull request on a candidate branch as authoritative
evidence that the worktree is still being worked on, and keeps it unconditionally
("A live PR is authoritative: the branch is still being worked on — never remove").
That rule was written for lanes in flight. It is exactly wrong for a parked lane: when
the factory parks an issue it leaves the PR open on purpose, for a human to pick up, and
the lane process exits. The worktree is then pinned forever — `autoGcOnRun` will not take
it (the worktree is registered, the issue is open, the mtime is fresh), and #998's
`doctor --reconcile` will not either (it reaps only dead-_run_ worktrees). The observed
consequence (2026-08-28) was one abandoned sibling checkout per parked issue on the Mac
Mini across three repositories, each carrying a full node_modules tree.
The counter-pressure is that these directories are the only place some work exists.
A parked lane may hold uncommitted changes (#986, #973) or commits that were never
pushed, and the local `ship-it/<n>-*` branch may be their only reachable handle. So the
question is not whether to reap, but what evidence is strong enough to authorize it.

## Decision

A factory worktree whose issue is labelled `factory:parked` or is closed on GitHub is
reapable, and that verdict outranks the open-PR keep. `GcReason` gains `issue-parked`
and `issue-closed`, and `sweepWorktrees` evaluates the issue's lifecycle state before the
PR-evidence block. Deleting the local branch remains a strictly separate decision: it
happens only when `hasPriorPushEvidence` proves the branch reached origin, because
`git branch -D` on an unpushed branch is unrecoverable and removing a local branch never
affects the open PR, which lives on the remote ref.
Three independent guards make the new reasons fail closed, and each is an
inconclusive-means-keep test, never an inconclusive-means-delete one. The worktree must
be clean by `isWorktreeClean` (a failed `git status` probe returns false ⇒ keep). No port
lease naming that path may hold a live pid — the `isLaneLive` dep, so a concurrent run is
never reaped out from under itself. And the issue state itself must be a real answer: no
octokit, no repo, or a throwing `issues.get` yields `null`, which falls through to
exactly today's PR-evidence rules rather than to removal.
The same evidence standard is applied at lane teardown by `reapLaneWorktree`, which
removes the lane's own worktree after park, failure, or run-done under the identical
clean gate and push gate. It deliberately does not reuse `cleanupWorktree`, whose
unconditional `git worktree remove --force` would destroy a dirty parked lane.

## Consequences

Positive: a parked issue no longer leaks a checkout; the pile that already exists is
cleared by one `factory doctor --reconcile` because the sweep is shared by
`factory worktree gc`, `autoGcOnRun`, and `--reconcile`; and the lane cleans up after
itself at teardown instead of waiting for the next run's GC pass.
Negative: reviving a parked issue by hand now costs a `git worktree add` — the checkout
is gone, though the branch survives on the remote and, when it was never pushed,
locally too. The sweep issues one extra `issues.get` per candidate worktree per pass
(memoized per issue number), so a repo with many candidates pays a few more API calls.
Dirty parked worktrees are still not cleaned by any automatic path — they warn and
persist, and clearing them stays a deliberate human `--force` action, which is the
trade #986/#973 already chose.
Accepted risk: the open-PR keep is now conditional, so a bug in reading the parked label
or the issue state could remove a live lane's worktree. That is why the live-lease veto
and the clean gate are mandatory and why a `null` issue state must fall back to the old
rules rather than to removal.

## References

- [Issue #1007 — After park or run-done, remove the lane worktree](https://github.com/on-par/software-factory/issues/1007)
- [Issue #980 — lifecycle reaping (parent)](https://github.com/on-par/software-factory/issues/980)
- [Issue #998 — doctor --reconcile reaps dead-run worktrees/branches](https://github.com/on-par/software-factory/issues/998)
