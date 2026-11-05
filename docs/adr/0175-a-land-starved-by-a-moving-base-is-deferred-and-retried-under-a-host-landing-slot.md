# ADR-0175: A land starved by a moving base is deferred and retried under a host landing slot

- Status: Accepted
- Date: 2026-11-05
- See also: [ADR-0037](0037-the-land-locks-cover-git-mutations-only-and-state-observed-unlocked-is-re-read-inside-the-lock.md) (land locks), [ADR-0146](0146-factory-merges-are-pinned-to-the-ci-verified-head-sha-and-a-head-moved-refusal-is-ci-unverified-and-never-retried.md) and [ADR-0170](0170-land-syncs-a-behind-pr-onto-current-main-and-merges-only-a-head-ci-verified-against-it-behind-strict-branch-protection.md) (SHA-pinned merge), issue #3957

## Context

`syncNow` merges `origin/main` into a PR and re-watches CI, at most `MAX_LAND_SYNC_ROUNDS` (3) times. On a busy host, sibling lanes merge into main faster than one CI watch finishes, so a green, reviewed PR can lose that race three times. The lane then parked the issue as `ci-failed`, and a human had to unpark it, which rebuilt a finished change.

## Decision

1. **`land-deferred` outcome.** The give-up after `MAX_LAND_SYNC_ROUNDS` syncs logs `land-deferred` (a warn, not a park, not terminal) and throws `LandDeferredError`, a `CiUnverifiedError` subclass. Every caller that does not handle it still parks `ci-failed` exactly as before. The message is unchanged ("base kept moving"). A real CI failure is still a `CiFailedError` and still parks.
2. **Retry store.** A lane that handles the error leaves the PR open, settles the issue `done`, adds no `factory:parked` label, no park comment and does not close the PR. It writes a record to `state/land-deferred.json` (issue, PR, branch, first deferral time, deferral count, next retry time, last message). The store is host-local, written atomically, and a missing or malformed file reads as empty.
3. **Backoff and cap.** Retry k waits 1, 2, then 4 minutes (the last value repeats). After `merge.maxLandDeferrals` deferrals (1-10, default 3) a further give-up parks `ci-failed` with the same "base kept moving" message, as today.
4. **Oldest first.** Due records (`nextRetryAt <= now`) retry in order of first deferral, then issue number. Each lane drains them before every claim and inside each land's heartbeat before its own land, so due deferred PRs land before new lands start on the host. The drain is fail-closed: a failure is a warn and never changes lane flow. A retry is land-only: sync, CI watch, SHA-pinned merge. It runs no PLAN or BUILD.
5. **Landing slot.** A new host lock, `state/land-slot.lock`, is the **landing slot**. It is distinct from the lane slot and the host build slot. A retry holds it from sync to merge, one record per hold, so sibling lanes cannot move main under it. An ordinary land takes the slot around each mutation. The lock order is always slot → git → merge. The file lock is not re-entrant, so a retry passes `holdsLandingSlot` and `landIssue` does not take it again. The slot wait is 4 hours, because a retry can span several CI watches.
6. **Classification of a retry.** Success clears the record. A repeated give-up (or CI not started) reschedules or, at the cap, parks `ci-failed`. Any other `CiFailedError` parks with its own reason, a merge conflict parks `conflict`, and a review or gate hold clears the record without parking.
7. **Surfaces.** `factory status` prints `== Land deferred ==` and `status --json` carries `landDeferred` rows. `run-issue --merge` retries a `LandDeferredError` until its deadline, then exits 14 with run-result outcome `land-deferred` and `landDeferrals`.

## Consequences

- A green PR starved by a busy base is retried instead of parked and rebuilt.
- ADR-0037 is refined: a retry holds the landing slot across CI, but the git and merge locks stay mutation-only, and ordinary lands do not hold any lock across a CI watch.
- ADR-0146 and ADR-0170 are unchanged: every merge, including a retry, is pinned to the CI-verified head.
- The slot and the store are host-local. Several hosts merging into one repo are not coordinated; that is #3656 (GitHub merge queue).
- Callers that do not know `LandDeferredError` (for example `factory land`) keep parking `ci-failed`.

## Alternatives considered

- **Raise `MAX_LAND_SYNC_ROUNDS`.** Rejected: it only moves the cliff and holds a lane longer.
- **Hold the git and merge locks across CI.** Rejected: it would stall every lane for a whole CI watch.
- **Re-run the issue through PLAN and BUILD.** Rejected: the change is finished; only the sync and merge are missing.
