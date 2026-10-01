# ADR-0127: factory reset refuses an issue with an active run, judged by an unexpired claim lease or a live run lock with a fresh issue heartbeat, and --force never overrides it

- Status: Accepted
- Date: 2026-10-01

## Context

`factory reset <issue>` (#1787, #1789) deletes an issue's lane worktree, branch, plan, phase snapshot, logs, rework history, lane-file claim and port leases. If a run is still working the issue, that deletion corrupts it mid-flight. Two signals say a run is active: the GitHub claim labels (`factory:in-progress`, `factory:claimed-by:*`) with a `factory:claim-expires:*` lease (#1500), and the checkout's run lock (#598). The run lock is per checkout, so alone it cannot say which issue is being worked; each issue's phase snapshot heartbeat (`lastActivityAt`, #1326) can. GitHub may be unconfigured or briefly unreachable.

## Decision

Before touching anything, `resetIssue` calls `findActiveRun` (`packages/cli/src/cli/reset.ts`) and refuses the issue, naming the holder and changing nothing, when either holds: the issue carries a claim label and `findStaleClaims` does not report it stale (a live, malformed or missing lease counts as active); or `readRunLockHolder` names a live pid and the issue's `lastActivityAt` is within `DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS`. When GitHub is not configured the label probe is skipped; when the label read throws, reset refuses (fail closed). Neither `--force` nor `--dry-run` overrides the refusal. Reset never releases or edits claim labels (`factory queue` owns them). `factory reset` exits 1 when any requested issue was refused; other issues still reset.

## Consequences

A live run can no longer be destroyed by reset, and "stale" means the same as in stale-claim release. A transient GitHub error blocks reset until retried; a claim with no lease label blocks until `factory queue` releases it; a crashed run's fresh heartbeat can block reset up to 15 minutes while another run holds the lock. Tokenless repos are protected only by the run-lock check. Any future "force through an active run" option needs its own decision and must not reuse `--force`.

References: issue #1790, issue #1500.
