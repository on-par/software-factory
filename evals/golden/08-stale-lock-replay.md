---
id: stale-lock-replay
expectedRoute: codex
replay: true
sourceIssue: 65
rubric:
  - Names packages/core/src/utils/lock.ts as the target
  - Covers stale-lock grace/timeout handling
---
# Reclaim stale git locks after the grace window

> Never-retire failure replay (issue #65).

A stale lock directory whose holder died is not reclaimed within the grace
window, so `withGitLock` stalls until the 30-minute timeout instead of
recovering when `lock.ts:59,111,121` indicate the holder is gone.

```stub-output
---
route: codex
---
# Spec: Reclaim stale git locks after the grace window (#0)
## Goal
Make withGitLock reclaim dead-holder lock directories once the configured stale-lock grace period has elapsed instead of waiting for the full timeout.
## Files / approach
Update packages/core/src/utils/lock.ts in the lock acquisition loop so a lock whose stat mtime is older than the grace period, computed as Date.now() - stat.mtimeMs > graceMs, is treated as stale and reclaimed before continuing to wait. Preserve the existing timeout behavior for non-stale locks.
## Tests
Add a regression test for a dead holder lock older than the grace period, then run npm run test -w @on-par/factory-core.
## Non-goals
No cross-process locking redesign; the util's existing single-process assumptions stay unchanged.
```
