# ADR-0089: worktree-gc's issue-warn dedup is a process-lifetime, in-memory singleton keyed by issue number

- Status: Accepted
- Date: 2026-09-09

## Context

Issue #1354: a worktree whose lane-branch issue number no longer exists on
GitHub (e.g. #9678562, #9872774) makes `resolveIssueDisposition`'s
`issues.get` call fail on every sweep, and the existing catch block logged
an unconditional warning each time. `sweepWorktrees` runs on every
iteration of the factory's long-lived daemon loop, so a single stale
worktree floods the log with the identical warning forever, obscuring other
signal. Removing or quarantining the worktree is explicitly out of scope
(that is #1352/#1357's dry-run-only flagging); the fix is confined to how
often the warning is allowed to repeat.

Three shapes were available for the dedup state: disk-persisted (survives
daemon restarts), threaded through the CLI call chain as an explicit
argument, or an in-memory tracker scoped to the `worktree-gc` module. Disk
persistence would outlive the condition it tracks — a stale suppression
entry could hide a _new_ problem after a restart, and it adds a file to
reason about for a warning that is inherently ephemeral (it exists only to
keep one process's log quiet). Threading it through the CLI would leak a
`worktree-gc`-internal concern into every call site that already ignores
this deps object today (three call sites in `cli/index.ts`, none of which
need to know dedup exists).

## Decision

`worktree-gc.ts` adds `IssueWarnDedup`, a small class keyed by issue number
with `record(issue)` (true on first occurrence since the last clear),
`suppressedCount(issue)`, and `reconcile(activeIssues)` (drops tracking for
any issue no longer among the current sweep's candidates).
`resolveIssueDisposition`'s catch block calls `record()`: true logs the
full warning as before; false logs a one-line
`"...— suppressed N repeated warning(s) (using PR/local evidence only)"`
summary instead of repeating the same text. `sweepWorktrees` reconciles the
tracker against the sweep's live candidate issue numbers before resolving
any disposition, so a worktree's suppression state clears once it's gone
(matching the acceptance criterion that a later reappearance, or a
different worktree reusing the number, warns in full again). A
module-level singleton (`defaultIssueWarnDedup`) is the default so the
daemon's repeated `sweepWorktrees` calls share one tracker for the life of
the process; `SweepDeps.issueWarnDedup` makes it injectable so tests never
share suppression state across cases.

## Consequences

Positive: the warning still fires once per newly-broken issue and once per
sweep-visible reappearance, but a permanently-stale worktree drops to one
short summary line per sweep instead of the full multi-clause message —
no CLI wiring or disk state required. Negative: the singleton is
per-process, so a daemon restart re-warns in full for a still-broken issue
(acceptable — restarts are rare relative to sweep frequency, and the
alternative is stale disk state surviving past the condition it recorded);
and every caller of `sweepWorktrees` in the same process shares one
tracker, so two logically distinct sweep configurations calling with
default deps intermix their suppression counts (no current call site does
this).

## References

- [Issue #1354: Eliminate repeated warn-spam for worktrees tied to nonexistent issues](https://github.com/on-par/software-factory/issues/1354)
- [ADR-0088: 404-issue detection in worktree-gc is a dry-run-only, additive report field](0088-404-issue-detection-in-worktree-gc-is-a-dry-run-only-additive-report-field.md)
