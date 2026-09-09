# ADR-0086: Local queue-entry staleness is judged from the per-issue phase-snapshot heartbeat, not the queue file's mtime

- Status: Accepted
- Date: 2026-09-09

## Context

`factory status`'s `== Queue ==` section printed every `<lane> <issue>` line
parsed from `.factory/state/queue` as if it were live, in-progress work. The
queue file, however, is never dequeued as entries are processed (#1342's
acceptance criteria require it to stay untouched), so an idle or crashed
local run left old entries sitting in the file indefinitely — an idle Mini
run on 2026-09-09 rendered ~60 of them as apparently in-progress backlog.

The obvious cheap signal, the queue file's own mtime, does not work: the
mtime is one timestamp shared across every entry in the file, and it gets
touched by unrelated writes — `rewriteQueueForDecomposition` (`queue/index.ts`)
rewrites the file whenever any issue in it decomposes, which would mark every
other entry "fresh" even though none of them are actually running.

`RunPhaseSnapshot.lastActivityAt` (`run/phase-snapshot.ts`, #1336) already
gives a truthful, per-issue heartbeat: it is bumped by `touchRunActivity`
throughout an issue's PLAN/BUILD/CHECK/SHIP execution, independent of any
other issue's queue state. `daemon/engine-supervisor.ts` already uses the
identical pattern — an activity timestamp compared against a 15-minute
threshold — to decide whether an in-process engine is stale and needs
restarting (`DEFAULT_STALE_THRESHOLD_MS`).

## Decision

A local queue entry is "active" for `factory status` display purposes only
when its issue has a `RunPhaseSnapshot` whose `lastActivityAt` is within 15
minutes of now (`DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS` in the new
`queue/activity.ts`, mirroring `daemon/engine-supervisor.ts`'s threshold and
value). An entry with no snapshot at all (never run) is also treated as
stale — it has no evidence of activity to justify showing it as in-progress.
Everything else is collapsed into a single stale-count line instead of being
either hidden entirely or misrepresented as active. `partitionLocalQueueByActivity`
only reads the queue file and per-issue snapshot files; it never rewrites
either, keeping `factory status` read-only with respect to queue state.

## Consequences

Positive: `factory status`'s Queue section reflects genuinely running work,
not whatever happens to still be sitting in the queue file; the check is
resilient to unrelated queue-file rewrites because it never reads the
queue file's own mtime. Negative: an entry queued for a lane that hasn't
started it yet (never run, or started more than 15 minutes ago and idle)
is folded into the stale count rather than shown individually — a future
consumer that wants to distinguish "queued, not yet started" from "queued,
actually orphaned" will need a richer per-entry status than this ADR's
binary active/stale split.

## References

- [Issue #1342](https://github.com/on-par/software-factory/issues/1342)
- [Issue #1336](https://github.com/on-par/software-factory/issues/1336)
