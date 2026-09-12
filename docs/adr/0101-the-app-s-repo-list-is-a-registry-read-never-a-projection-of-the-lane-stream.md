# ADR-0101: The app's repo list is a registry read, never a projection of the lane stream

- Status: Accepted
- Date: 2026-09-12

## Context

ADR-0038 and ADR-0039 state that the dashboard's lane set is a pure fold of the `GET /events`
SSE stream and that the frontend performs "no other network read — no snapshot fetch, no
polling timer, no second source". Those ADRs were written about lane state, for which there is
deliberately no queryable resource (ADR-0029 makes the lifecycle bus an in-process fan-out
that is not a source of truth). #1401 needs something different: after the app registers a
validated checkout with factoryd, the operator must be able to see that repo listed as active.
That fact lives in ~/.factory/registry.json, which factoryd already exposes as a real,
authoritative, loopback-authorized resource at `GET /repos` (ADR-0034) — the same endpoint the
Settings screen already reads to resolve its slug. The tempting shortcut is to fold the
registry into the existing board: seed LaneBoard's `attachedRepos` from it, or synthesize idle
lane cards for registered repos. That would make the board's inputs two, and would let
registry state assert something about lanes that no event ever reported — exactly what
ADR-0038/0039 forbid. The alternative temptation is to avoid the read entirely and paint the
just-posted slug into the list from the client's own request, which would show a repo as
active on the strength of what the app asked for rather than what the daemon persisted.

## Decision

The app's repo list is a separate, registry-backed view with its own region, its own module
(`packages/dashboard/src/repoListing.ts`) and its own component (`RepoList.tsx`). It reads
factoryd's `GET /repos` and renders each entry's slug, state and checkout path exactly as the
registry reports them; it never invents a row from a request the app made, and a repo appears
as active only because factoryd said it is. The read is one-shot: once on mount and once more
each time an attach succeeds. There is no timer and no polling. The list is a leaf — its data
flows into nothing else, and in particular never into `LaneBoard`, whose lane set stays a pure
projection of the SSE stream under ADR-0038 and ADR-0039. `LaneBoard`'s `attachedRepos` prop
keeps its existing injected-config source.

## Consequences

Positive: the operator gets a truthful answer to "is this repo registered and active?" sourced
from the daemon's own registry; a rejected attach cannot appear as active, because nothing is
ever rendered that factoryd did not return; the board keeps exactly one input, so ADR-0038 and
ADR-0039 survive intact; and the two concerns stay separable in the code, with a pure
`parseRepoListing` that is testable without a DOM or a server. Negative: the list can go stale
— a pause, detach or attach performed outside this tab is invisible until the next mount or
attach, and the no-polling rule means we accept that rather than reconcile; the app now has a
second network read alongside the stream, so "the dashboard reads only /events" is no longer
literally true and future readers must reach for this ADR to see the boundary; and slug,
state and path are mirrored as app-side types rather than imported from core, which is
Node-only, so a wire-shape change in the registry must be mirrored here by hand.

## References

- [Issue](https://github.com/on-par/software-factory/issues/1401)
- [ADR-0038 — The status board's lane set is derived only from the live event stream](https://github.com/on-par/software-factory/blob/main/docs/adr/0038-the-status-board-s-lane-set-is-derived-only-from-the-live-event-stream-never-from-a-snapshot.md)
- [ADR-0034 — factoryd's HTTP API is authorized by its loopback binding alone](https://github.com/on-par/software-factory/blob/main/docs/adr/0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md)
