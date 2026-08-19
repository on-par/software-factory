# ADR-0030: A closed target issue is skipped before any resource is committed, and the skip is not a park

- Status: Accepted
- Date: 2026-08-19

## Context

`.factory/queue` is append-only in practice: nothing prunes an entry when its issue lands, and
the repo's own queue carries hand-written `# merged ... via PR #649` annotations because a human
has to remember to do it. Any relaunch of `factory run` or `factory supervise` after a partial
run therefore re-reads the same queue from the top. On 2026-08-12 that re-ran PLAN against an
issue merged and closed minutes earlier by PR #680 — full ADR context injection and spec
generation — and was only stopped because a human was watching. Nothing on the path asked
whether the issue was still open: `createGithubIssueAdapter.resolve()` did not request `state`
from the GitHub API at all, and `shipIssue` fetched only the title before creating a worktree,
leasing a port, and calling the boss model.

Two forces shape the fix. First, cost is committed early: the worktree and the port lease are
taken before PLAN, so a check that runs "at the start of PLAN" is already too late. Second, a
closed issue is not a failure — the work is done. The pipeline's existing terminal vocabulary is
all park-shaped (`escalate`, `fail`, `timeout`, `conflict`), and reusing any of it would light up
human-intervention KPIs and stop the lane, which is exactly the wrong response to "there is
nothing to do here".

## Decision

The factory refuses to start work on a closed target issue, and it refuses before committing any
resource. The issue's `state` travels on the canonical work-request seam — `WorkIssueClient`
reports it, `createGithubIssueAdapter.resolve()` puts it on `WorkRequest.state`, and
`closedWorkSkipReason()` is the single place that decides what "already done" means. `shipIssue`
consults it immediately after resolving the work request and before the worktree, the port
lease, and PLAN.

A skip is a clean outcome, never a park. It emits its own `EventKind`,
`skipped-already-closed`, classified `{ severity: 'info', isPark: false, isTerminal: true }`, and
raises a typed `IssueSkippedError` that `runLane` catches to advance to the next queue entry
without parking the lane — the same shape as the existing `AwaitingReviewError` path. Because no
run was attempted, an issue whose only events are a skip is excluded from the `runs` cohort in
`computeHealthKpis`, so skips never move merge, rework, or autonomy rates.

Absent state fails open. Only the literal `'closed'` skips; unknown, missing, or non-GitHub
state is treated as open. A source that cannot report state — a local Markdown brief — is never
blocked by this gate. A failed state lookup surfaces as an ordinary preflight error, exactly as a
failed title lookup did before this change — the gate adds a field to an existing fetch, not a
second network call with its own failure mode.

## Consequences

Positive: a relaunch against a stale queue costs one GitHub GET per already-landed entry instead
of a PLAN→BUILD→CHECK cycle, and the reason is legible in `factory logs`/`factory status` rather
than inferred from a confusing duplicate PR. The skip decision lives in one pure, unit-testable
function instead of being spread across PLAN and the CLI. `shipIssue` now gets its title from
the same work-request seam as everything else, removing a bespoke `getIssueTitle` fetch from
that path (the helper itself stays, since `landIssue` still calls it on an unrelated path).

Negative and accepted: fail-open means a GitHub response that omits `state` still burns a full
cycle — we prefer that to a false skip silently dropping real work. The gate answers "was this
closed when the run started", not "did it close mid-run"; in-flight closure is still out of
scope. Every new caller of `shipIssue` inherits an obligation to handle `IssueSkippedError` or
surface a raw error, and every future terminal-but-successful outcome must decide explicitly
whether it belongs in the KPI run cohort.

## References

- [Issue #681 — PLAN starts on already-closed issues](https://github.com/on-par/software-factory/issues/681)
- [ADR-0001 — Boss–worker–checker pipeline with per-issue build routing](0001-boss-worker-checker-pipeline.md)
