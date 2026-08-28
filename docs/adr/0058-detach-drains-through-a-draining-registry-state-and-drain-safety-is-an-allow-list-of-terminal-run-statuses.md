# ADR-0058: Detach drains through a `draining` registry state, and drain safety is an allow-list of terminal run statuses

- Status: Accepted
- Date: 2026-08-19

## Context

Epic #761's registry keeps `detached` entries as tombstones so a detach is auditable,
and ADR-0036 fixed that a tombstone is never revived — pause and resume act only on
live entries. Detach (#780) is the story that writes those tombstones, and it raises
two questions the code alone cannot settle.

First, a drain is not instantaneous. The acceptance criterion requires that no new
issues are claimed for the repo from the moment the DELETE is accepted, while the
in-flight lane still runs to a safe boundary. `dispatchableRepos` is a pure filter over
the on-disk registry, so "stop claiming" has to be a persisted fact, not an in-memory
flag in a process that may crash. The two existing live states are both wrong for it:
leaving the entry `active` keeps it dispatchable, and writing `paused` makes an
in-progress detach indistinguishable from an operator pause — a crash mid-drain would
leave a repo that a resume would cheerfully return to dispatch, with the detach never
finished.

Second, "safe boundary" needs a definition that survives the RunStatus union growing.
The issue names merged, parked, and awaiting-review; the union also carries pending,
planning, building, checking, reworking, shipping, ready, escalated, and failed, and
future stories will add more. A deny-list of in-flight statuses would silently treat
every newly added status as safe to abandon, which is precisely the corruption this
story exists to prevent.

A third constraint shapes both: factoryd has no in-process dispatch loop yet, so there
is no lane-state source to read. The detach gate must be written against a seam the
loop story can fill, and it must not read or write the target repo's own `.factory/`
directory — the issue makes leaving that directory untouched a hard guarantee.

## Decision

`RepoState` gains a fourth value, `draining`, and a default detach is a two-write
protocol. The first write sets `draining` and is the commit point that stops new
claims; `dispatchableRepos` continues to admit only `active`, so the repo leaves the
dispatch set the instant that write lands. The second write sets `detached` and
happens only after the lane poll comes back clean. A crash between the two leaves the
repo in `draining`: not dispatchable, and visibly mid-detach rather than merely
paused.

`setRepoState` refuses a `draining` entry with `reason: 'draining'` (HTTP 409) and no
write, extending ADR-0036's live-entries-only rule — a resume must never re-open
dispatch while a detach is in progress.

Safety is an allow-list. `SAFE_DETACH_STATUSES` names exactly `ready`,
`awaiting-review`, `parked`, `escalated`, `merged`, and `failed`; every other
`RunStatus`, including any added later, is treated as in-flight and blocks the drain.
Adding a status that is genuinely safe to stop at is therefore a deliberate edit to
that set, not a silent default.

The lane statuses arrive through an injected `readLaneStatuses(slug)` seam whose
production default reports no in-flight lanes, and the poll is bounded by an injected
clock: an unclearable drain returns `drain-timeout` (HTTP 409) with the entry left in
`draining` rather than holding the connection open. `?force=true` skips the wait
entirely, writes the tombstone immediately, and never calls the lane reader — a
documented escape hatch that may orphan worktrees and a running lane. Neither path
reads or writes anything under the target repo's `.factory/` directory; the only file
either writes is the user-scoped registry.

## Consequences

Positive: "stop claiming new issues" is a durable fact rather than a promise held in
one process's memory, and it survives a crash in the safe direction. An operator can
tell a detach-in-progress from a pause by reading the registry, and pause/resume
cannot race a detach back into dispatch. New RunStatus values fail closed — a drain
waits for a status nobody classified rather than abandoning a lane at it. The
lane-status seam lets the detach gate ship and be tested deterministically before the
dispatch loop exists, and the untouched-`.factory/` guarantee is structural rather
than a promise.

Negative: a fourth state is more registry surface, and every future state-changing
repo route must now decide what it does about `draining` as well as `detached`, on top
of ADR-0036's rule. A crashed factoryd can strand an entry in `draining` that only a
new DELETE (possibly with `?force=true`) clears — there is no automatic recovery.
Until the dispatch loop wires the real reader, the default seam reports no in-flight
lanes, so a default detach completes immediately and the drain wait is exercised only
by tests; the loop story must not forget to inject it. The allow-list has to be
revisited whenever RunStatus grows, and forgetting shows up as a drain that times out
rather than as a compile error.

## References

- [Issue #780 — factoryd: detach a repo via drain-based DELETE with force override](https://github.com/on-par/software-factory/issues/780)
- [Epic #761 — factoryd: repo registry + attach/detach/pause HTTP API](https://github.com/on-par/software-factory/issues/761)
- [ADR-0036 — Pause and resume act only on live registry entries](0036-pause-and-resume-act-only-on-live-registry-entries-a-detached-tombstone-is-never-revived.md)
