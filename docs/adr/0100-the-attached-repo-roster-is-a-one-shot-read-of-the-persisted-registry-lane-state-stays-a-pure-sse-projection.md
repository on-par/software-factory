# ADR-0100: The attached-repo roster is a one-shot read of the persisted registry; lane state stays a pure SSE projection

- Status: Accepted
- Date: 2026-09-12

## Context

`factoryd` already persists an attach durably: `attachRepo`
(`packages/core/src/daemon/repos-attach.ts`) upserts `{ path, attachedAt, state:
'active' }` into `~/.factory/registry.json` via the atomic `writeRegistry`, and
`GET /repos` re-reads that file on every request
(`packages/core/src/daemon/factoryd-http.ts`). The gap was the read-back: the
dashboard's repo list came from the build-time env var —
`parseAttachedRepos(import.meta.env.VITE_FACTORY_REPOS)` in `App.tsx` — which by
construction cannot know about a repo attached at run time. A page reload dropped
it (#1403, epic #761), even though the daemon never forgot it.

`laneBoardState.ts`'s `groupLanesByRepo` previously documented `attachedRepos` as
"injected config, never a network read — see ADR-0038/ADR-0039", which was true
for the lane-_state_ half of the app: ADR-0038 requires the board's lane **set**
to be derived only from the live `GET /events` stream, never from a snapshot or a
poll, and ADR-0039 requires the board to be a pure projection of that stream where
unobserved state renders as pending rather than inferred. Both are about how lane
cards come to exist and what they report — not about which repo slugs seed empty
groups on the board. `SettingsView` already reads `GET /repos` outside the SSE
stream for policy resolution, which is itself proof this repo already treats
"which repos exist" as a separate concern from "what is a lane doing", governed by
its own transport rules rather than by ADR-0038/ADR-0039. This decision draws that
line explicitly rather than leaving the stale comment to imply a network read of
the repo roster would violate the lane-state architecture.

## Decision

`packages/dashboard/src/attachedRepos.ts` adds a `useAttachedRepos` hook that
performs exactly one `GET /repos` on mount, keeps only registry entries with
`state === 'active'`, and merges the result with the build-time configured slugs
(`mergeAttachedRepos`: configured slugs keep their configured order, any newly
discovered active slug is appended). `App.tsx` feeds the merged list to
`LaneBoard`'s existing `attachedRepos` prop in place of the raw parsed env value.
The fetch fails soft to `[]` — a network error, a non-OK response, or an
unparseable body all resolve without throwing — so a reload with `factoryd`
unreachable falls back to exactly the previous (config-only) behavior rather than
showing an error state.

This is deliberately a one-shot read, not a poll or a stream: the roster changes
at attach/detach time, an infrequent operator action, and the dashboard already
reads `GET /repos` this way in `SettingsView` for policy resolution, so the
transport is precedented. Lane _state_ is untouched — it remains a pure reduction
over the lifecycle SSE stream per ADR-0038/ADR-0039, with `groupLanesByRepo`'s
attachedRepos-seeds-idle-groups behavior unchanged. The stale "never a network
read" comment on `groupLanesByRepo` is corrected to point at this ADR instead of
implying a rule that was never about the repo roster.

Sibling issue #1401 (parked) owns surfacing a _newly_ attached repo without a
reload (e.g. via a live event); this decision covers only the reload path, which
is #1403's acceptance criteria.

## Consequences

Positive: an attach now survives a reload without any change to how attaches are
persisted (the registry format and upsert semantics are reused unchanged) or to
how lane state is computed; the fix is isolated to one new dashboard module plus
one call-site swap in `App.tsx`.

Negative: the roster can be briefly stale between an attach on one client and a
reload on another (bounded by that reload's own `GET /repos`, not by any polling
interval this change introduces) — acceptable because attach/detach is a rare,
operator-driven action, not a live signal the board needs to track continuously.
A truly live roster (an attach appearing without a reload) is explicitly out of
scope here and left to #1401.

## References

- [Issue #1403 — Persist attached repo across reload](https://github.com/on-par/software-factory/issues/1403)
- [ADR-0038](0038-the-status-board-s-lane-set-is-derived-only-from-the-live-event-stream-never-from-a-snapshot.md) — constrains the lane _set_, not the repo roster
- [ADR-0039](0039-the-status-board-is-a-pure-projection-of-the-sse-stream-and-unobserved-state-is-pending-never-inferred.md) — constrains lane _state_ reporting, not the repo roster
