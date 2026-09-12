# ADR-0095: Repo detail is addressed by the `?repo=` query parameter and filtered on both the server and the client

- Status: Accepted
- Date: 2026-09-12

## Context

The factory server already relays the lane lifecycle bus as SSE and accepts an optional
`?repo=owner/name` query parameter that scopes the stream to one attached repository, tagging
every frame with its `repo` slug (`packages/server/src/index.ts`, `packages/server/src/sse.ts`).
The dashboard, by contrast, had no repository concept at all: it subscribed to the unfiltered
firehose and folded every frame into one fleet-wide lane board. Epic #1377 asks for a repo detail
screen, and sibling stories will add more drilldowns, so the project needed an answer to two
questions before the first one landed: how is a detail view addressed, and who is responsible for
making sure a detail view only ever shows one repository's lanes. Adding a client-side router for
`/repos/:owner/:name` would have introduced a routing dependency and architecture for a
single-page slice, and trusting the server's `?repo=` filter alone would leave the view's central
invariant enforced entirely outside the code that renders it — invisible to its own tests.

## Decision

A repo detail view is addressed by the `?repo=owner/name` query parameter on the existing
single-page app, not by a client-side route, and the URL is the only source of the selected
repository. The dashboard subscribes to the repo-scoped stream `/events?repo=<encoded>` so the
wire carries only that repository's traffic, and it _also_ re-checks `event.repo` against the
selected slug in `reduceRepoLaneEvent` before folding a frame into board state. Both filters are
mandatory. The client-side check is not redundant defensive coding: it is where the "only this
repo's lanes update this view" invariant is stated in code and proved by tests, and it is what
keeps a replayed, mis-tagged, or untagged frame — including one delivered across a reconnect with
`Last-Event-ID` — out of the view. The repo-tagged wire shape lives in `@on-par/contracts` as
`RepositoryLaneLifecycleEventSchema`, and both the server and the dashboard refer to that one
definition.

## Consequences

Positive: the detail view is linkable and bookmarkable with no router dependency, and the fleet
overview can link into it with a plain anchor, so sibling stories under #1377 need no navigation
infrastructure. The isolation invariant is unit-testable in a pure reducer instead of only
observable end to end. A single contracts schema means the client cannot drift from the server's
tagging.

Negative: the filter is expressed twice, so a future change to repo scoping must be made in both
places or the client silently becomes the stricter one. Query-param addressing is cosmetically
weaker than a real path route and will have to be migrated if the app grows real routing. Frames
that legitimately carry no `repo` are dropped in detail mode rather than shown, which is
deliberate but means an untagged producer is invisible there.
