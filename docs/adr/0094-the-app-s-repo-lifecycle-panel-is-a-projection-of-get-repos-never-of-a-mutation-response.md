# ADR-0094: The app's repo lifecycle panel is a projection of GET /repos, never of a mutation response

- Status: Accepted
- Date: 2026-09-12

## Context

factoryd's registry (~/.factory/registry.json) is the single source of truth for which repos the
daemon dispatches work to; `dispatchableRepos` reads only `active` entries, and detach moves an
entry through `draining` to a retained `detached` tombstone in the background, minutes or hours
after the operator's click (ADR-0058, ADR-0059). The app's POST pause/resume and DELETE detach
responses each carry the registry entry that was just written, which makes it tempting to splice
that entry — or an optimistically guessed one — straight into the rendered row. Both shortcuts make
the app a second source of truth: a spliced row goes stale the moment `drainAndDetach` finishes
flipping `draining` to `detached`, and an optimistic row can show `paused` for a repo whose write
was rejected. ADR-0039 already settled the same question for the read path — the status board is a
pure projection of the SSE stream and unobserved state is `pending`, never inferred — and the
control plane deserves the same rule rather than a second, looser one.

## Decision

The app's repo lifecycle surface renders registry state from `GET /repos` and from nothing else.
`RepoLifecyclePanel` loads the listing on mount and re-reads it after every successful pause,
resume, and detach; a mutation response is used only to decide success or failure and to surface
factoryd's own `error` detail, never to update a row. The panel keeps no derived repo state of its
own beyond in-flight/error bookkeeping, and it never guesses a post-click state before the refetch
lands. Button availability is likewise derived from the last projected state: Pause only for
`active`, Resume only for `paused`, Detach only for `active` or `paused` — so a `draining` entry
or a `detached` tombstone can never be sent a lifecycle request, which is ADR-0036's
live-entries-only rule enforced at the app edge as well as in `setRepoState`.

## Consequences

Positive: the app cannot disagree with the registry; a background drain completing is picked up by
the next projection instead of leaving a stale row; there is exactly one code path that writes panel
state, which keeps the component small and its tests direct. Enforcing the live-entries rule in the
UI also means a rejected revive is a button that was never offered rather than an error to explain.
Negative: every mutation costs a second round trip, and the row briefly shows its pre-click state
until the refetch resolves — no optimistic snappiness. A future polling or SSE-backed registry feed
must replace the refetch, not sit alongside a locally mutated copy.

## References

- [ADR-0039 — The status board is a pure projection of the SSE stream](https://github.com/on-par/software-factory/blob/main/docs/adr/0039-the-status-board-is-a-pure-projection-of-the-sse-stream-and-unobserved-state-is-pending-never-inferred.md)
- [ADR-0036 — Pause and resume act only on live registry entries](https://github.com/on-par/software-factory/blob/main/docs/adr/0036-pause-and-resume-act-only-on-live-registry-entries-a-detached-tombstone-is-never-revived.md)
- [Issue #1382 — App onboarding: pause, resume, and detach attached repos](https://github.com/on-par/software-factory/issues/1382)
