# ADR-0109: Auto-ingest holds back a same-cycle ready issue that names an already-admitted issue's primary file

- Status: Accepted
- Date: 2026-09-18

## Context

Auto-decomposition (the factory's own child-issue filer) regularly produces two open
issues that target the same source file — observed twice in one batch in factory-app's
2026-09-17 retro (#568 vs #598 on `intake-lane.tsx`, #537 vs #540 on
`queue-snapshot.ts`). `runAutoIngest` (packages/core/src/ingest/index.ts) is the
factory's only unattended admission path — it polls GitHub every supervise cycle for
issues labeled "ready" and appends new ones to the queue with no cross-issue check at
all. Once both land in the queue the scheduler runs them in parallel lanes; they park
on conflicting diffs or merge into a duplicate pair, discovered only after both burn a
full plan→build cycle. 21+ merged "docs(adr): issue #X already delivered by #Y" PRs in
factory-app are downstream of this gap (issue #1514).

## Decision

`runAutoIngest` scans each cycle's batch of ready-issue candidates (title + body, now
fetched via `gh issue list --json number,title,body,updatedAt`) with a new pure guard,
`findFileOverlapCollisions` (packages/core/src/ingest/file-overlap-guard.ts). The guard
extracts filename-like tokens matching a source-file-extension allowlist
(ts/tsx/js/jsx/py/go/... ), normalizes to a lowercased basename, ignores a small
denylist of generic names (package.json, index.ts, README.md, ...), and — scanning
candidates in ascending issue-number order — flags any candidate that names a file
already named by an earlier candidate in the same batch. A flagged candidate is held
back this cycle (reported in `AutoIngestResult.skippedFileOverlap`, not appended to the
queue, and excluded from the watermark advance so it is retried next cycle) instead of
being admitted alongside the issue it collides with. `createIngestHook`
(packages/cli/src/cli/index.ts) logs one `ingest_file_overlap_held` event per held-back
issue naming the collision, and resolves `AutoIngestOptions.forceAdmit` from
`FACTORY_INGEST_FORCE_ADMIT=1` to admit every candidate unconditionally, matching
pre-change behavior exactly when set.

## Consequences

Positive: the two documented factory-app collision patterns can no longer both be
auto-admitted in the same cycle without a human explicitly forcing it; a held-back
issue is never silently dropped since it re-enters consideration every future cycle
until it stops colliding. Negative: the check only compares issues discovered _ready_
in the same ingest cycle — an issue already sitting in the queue from a prior cycle, or
a same-file collision against a PR merged in the last N days, is not caught by this
pass (tracked as follow-up work, not this issue's scope); the extension-allowlist
heuristic can still false-positive on two unrelated issues that happen to both mention
a common filename, mitigated by the generic-name denylist and the force-admit escape
hatch but not eliminated — acceptable for a "cheap heuristic first" pass per the issue.

## References

- Issue #1514: triage: block admission of two open issues that name the same primary file
  https://github.com/on-par/software-factory/issues/1514
