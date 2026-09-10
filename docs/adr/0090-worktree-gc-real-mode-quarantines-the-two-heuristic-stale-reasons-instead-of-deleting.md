# ADR-0090: worktree-gc's real mode quarantines the two heuristic stale reasons instead of deleting

- Status: Accepted
- Date: 2026-09-09

## Context

Issue #1355: `sweepWorktrees` computes two additional stale signals —
`issue-not-found` (the lane branch's issue number 404s on GitHub, #1352/
ADR-0088) and `no-active-claim` (the branch's PR is merged or closed but the
owning issue carries no active `factory:claimed-by:*` label, #1353) — but
both were wired to the dry-run report only. Nothing acted on them in real
mode, so worktrees matching either signal piled up indefinitely even while
`factory worktree-gc` (non-dry-run) and `factory run`'s auto-gc kept
running. The issue asks for real mode to actually remove or quarantine
flagged worktrees, record an audit-log entry for the action, and leave every
non-flagged worktree untouched.

Every existing removal reason (`merged`, `remote-gone`, `ttl-expired`,
`issue-closed`, `issue-parked`) rests on hard evidence: a GitHub merge/close
verdict, an elapsed TTL, or a closed/parked owning issue, each cross-checked
against remote branch state before the local branch is force-deleted
(`BRANCH_REAPABLE_REASONS`). `issue-not-found` and `no-active-claim` are
categorically weaker: a 404 could be a rename or a transient GitHub-side
lookup mistake, and "no active claim label" only means the queue's
bookkeeping moved on, not that the branch's content is safe to destroy.
Treating them identically to the hard-evidence reasons — hard-deleting the
worktree and force-deleting the branch — would risk destroying work on a
false positive with no recovery path (explicitly out of scope per the
issue's "recovering worktrees after removal" exclusion, which presumes
something is left to recover).

## Decision

`GcCandidate` gains an `action: 'remove' | 'quarantine'` field. Every
existing hard-evidence reason keeps `action: 'remove'` (unchanged: `git
worktree remove --force`, then branch force-delete when
`BRANCH_REAPABLE_REASONS`/`branchReapable` allows it). `issue-not-found` and
`no-active-claim` (`QUARANTINE_REASONS`) get `action: 'quarantine'`: real
mode relocates the worktree via `git worktree move` into
`<repoRoot>/.factory/state/quarantine/` (falling back to a manual
`renameSync` if the git move itself fails) and never force-deletes the
branch — `BRANCH_REAPABLE_REASONS` excludes both reasons and `branchReapable`
is never set for them, so `deleteReapedBranches` skips them unconditionally.
Both heuristic checks now also run inside the main per-candidate loop in
real mode (previously only inside the `dryRun` branch), gated on: no
stronger reason already claimed the candidate, the worktree is clean (the
same "never touch live work" rule every acting tier above already follows),
and the branch's PR isn't open (an open PR is authoritative and already
short-circuits the reason chain above — the heuristic tier must never
second-guess it). The two issue-existence/claim resolver caches are hoisted
above the main loop so both the new real-mode tier and the existing
dry-run-only diagnostic block share one cache per sweep. `sweepWorktrees`
logs a `'worktree-gc'` audit entry (existing `EventKind`, same convention
`utils/index.ts`'s `reapLaneWorktree` already uses) recording the worktree
path and reason for every real-mode remove or quarantine, on success; a
non-fatal `'warn'` covers a failed move/remove, matching the reap/prune
failure-handling already in this function. `GcReport`'s `issueNotFound` /
`issueUnverifiable` / `noActiveClaim` fields are unchanged and still always
empty outside dry-run — dry-run's diagnostics remain a separate, unconditional
report over every candidate regardless of reason (ADR-0088/0089); real
mode's equivalent signal now shows up as a `removed` entry instead.

## Consequences

Positive: flagged worktrees stop accumulating forever in real mode without
risking data loss on a false-positive heuristic signal — quarantine
preserves every file (including uncommitted changes, since the tier still
requires a clean tree before acting) at a known, inspectable location
instead of destroying it; every acting removal or quarantine is now
audit-logged, closing the gap the issue calls out ("didn't exist before").
Negative: real (non-dry-run) sweeps now spend one extra `issues.get` (and,
for a merged/closed PR, one extra claim-label `issues.get`) per candidate
that reaches the heuristic tier — a cost ADR-0088 explicitly deferred to
"a future feature that acts on the 404 signal"; this is that feature.
Nothing currently prunes `.factory/state/quarantine/` itself — cleaning up
confirmed-safe-to-delete quarantined worktrees is future work, matching the
issue's explicit "recovering or restoring worktrees after removal" and
"changing how the TUI/status displays quarantined worktrees" exclusions.

## References

- [Issue #1355: Remove or quarantine worktrees flagged as stale by worktree-gc](https://github.com/on-par/software-factory/issues/1355)
- [ADR-0088: 404-issue detection in worktree-gc is a dry-run-only, additive report field](0088-404-issue-detection-in-worktree-gc-is-a-dry-run-only-additive-report-field.md)
- [ADR-0089: worktree-gc's issue-warn dedup is a process-lifetime, in-memory singleton keyed by issue number](0089-worktree-gc-issue-warn-dedup-is-a-process-lifetime-in-memory-singleton-keyed-by-issue-number.md)
