# ADR-0088: 404-issue detection in worktree-gc is a dry-run-only, additive report field

- Status: Accepted
- Date: 2026-09-09

## Context

Issue #1352 asks worktree-gc to flag ship-it worktrees whose branch-encoded
issue number 404s on GitHub, surfaced only in the dry-run report —
"actually removing or quarantining any worktree" is explicitly out of
scope. sweepWorktrees already has GitHub-evidence ADRs governing when and
how it consults GitHub (ADR-0027: merge/close evidence sourced from the
GitHub API with local-git fallback; ADR-0073/0074: issue disposition
outranking PR state), and it is invoked from two very different call sites:
`factory worktree-gc` (both dry-run and real, via cmdWorktreeGc) and
`factory run`'s auto-gc-on-run path (always real, never dry-run). Adding a
GitHub call to the real path costs API quota on every automatic run for a
signal nothing there consumes, and risks being mistaken later for a removal
signal if it fed into GcReason.

## Decision

sweepWorktrees resolves each factory-owned candidate's lane-issue existence
via `octokit.rest.issues.get` only when its `dryRun` option is true, and
only when a GitHub client and repo are configured. The result populates two
new, purely additive `GcReport` fields — `issueNotFound` (the lookup 404s)
and `issueUnverifiable` (the lookup throws any other error, e.g. rate limit
or network failure) — which `formatGcReport` renders as extra report
sections. Neither field is read by, or written from, the existing
`GcReason` / `BRANCH_REAPABLE_REASONS` removal-classification logic. Real
(non-dry-run) sweeps never perform this check and always return both
fields empty.

## Consequences

Positive: zero behavior change and zero added GitHub-API cost on the real
removal path (`factory run`'s auto-gc and non-dry-run `factory
worktree-gc`); the 404/unverifiable signal is visible everywhere the
dry-run report already surfaces, with no new CLI flag. Negative: a future
feature that acts on the 404 signal (e.g. actually quarantining those
worktrees) must deliberately opt this check into the real-sweep path
rather than getting it for free from this change; `factory worktree-gc
--dry-run` now costs one extra `issues.get` call per distinct lane issue
number beyond what issue-disposition resolution already spends, since the
two checks are independent rather than sharing one lookup.

## References

- [Issue #1352: Flag worktrees tied to nonexistent (404) GitHub issues in worktree-gc dry-run](https://github.com/on-par/software-factory/issues/1352)
- [ADR-0027: Worktree GC sources merge/close evidence from the GitHub API](https://github.com/on-par/software-factory/blob/main/docs/adr/0027-worktree-gc-sources-merge-close-evidence-from-the-github-api-local-git-state-is-only-a-fallback.md)
