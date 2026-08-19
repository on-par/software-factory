# ADR-0039: The status board is a pure projection of the SSE stream, and unobserved state is pending, never inferred

- Status: Accepted
- Date: 2026-08-19

## Context

#593 adds the first live consumer of the `GET /events` stream that #592 put on
`packages/server`. Two design pressures pull against each other. ADR-0029 makes the
lane lifecycle bus an in-process fan-out that is explicitly not a source of truth and
that no consumer may read state back from, and ADR-0031 makes SSE resume a bounded
256-event in-process ring with ids that reset on restart — so a client that connects
late, or after a server restart, provably cannot see the whole history of a lane. The
obvious ways to paper over that gap are exactly the ones that would erode those two
ADRs: add a REST snapshot endpoint to bootstrap the board, poll it to reconcile, or
have the frontend infer that earlier phases must have completed because a later phase
is reporting progress. The issue's acceptance criteria independently forbid the first
two ("a single EventSource subscription ... no polling anywhere in the frontend"), and
the third is worse than a gap: a stepper that shows PLAN as done because BUILD is
running is asserting an outcome nobody observed, and it would show that same
confident-but-invented state for a lane whose PLAN actually failed before the client
connected. There is also a transport-shaped decision hiding here: the server sets no
CORS headers and binds loopback by ADR-0034's reasoning, so a board served from Vite's
origin can only reach the stream same-origin.

## Decision

The status board is a pure projection of the event stream and holds no state the
stream did not give it. All board state is produced by one pure fold,
`applyLifecycleEvent`, over `LaneLifecycleEvent`s delivered by exactly one
`EventSource` subscription; the frontend adds no polling, no timer-driven refresh, and
no second endpoint to reconcile against. A phase segment is marked done or failed only
by an event for that phase — a later phase's event never back-fills an earlier one, and
a phase the client never observed renders as pending, which is the board's way of
saying "unknown" rather than "not started". Reconnection is delegated entirely to
`EventSource`'s own retry against the server's `retry: 2000` hint plus the
`Last-Event-ID` replay ring, so the frontend owns no retry policy of its own. The board
reaches the stream at the same-origin path `/events`, with the dashboard's Vite dev
server proxying to `127.0.0.1:8787`; CORS stays off the server.

## Consequences

Positive: the board can never desynchronise from the engine's own view, because it has
no independent view to desynchronise; ADR-0029's "never read state back from the bus"
and ADR-0031's bounded-ring contract both survive their first real consumer; there is
exactly one place (a pure function) where every stepper, chip and log-tail rule lives,
so all of it is unit-testable without a browser or a live server; and the server keeps
its narrow, CORS-free, loopback-only surface.
Negative: a client that attaches mid-run shows pending segments for phases that in fact
already completed, which reads as a gap and will prompt "why is PLAN grey?" until a
later story adds a real snapshot source; the board's memory is the page's lifetime, so
a refresh loses everything older than the replay ring; deployment beyond localhost will
need either the proxy reproduced in whatever serves the built assets or an explicit,
separately-decided CORS/auth story; and the no-polling rule means a silently wedged
connection surfaces only as the disconnected chip.

## References

- [Issue](https://github.com/on-par/software-factory/issues/593)
- [ADR-0029 — Lane lifecycle events are an in-process fan-out, never a second source of truth](https://github.com/on-par/software-factory/blob/main/docs/adr/0029-lane-lifecycle-events-are-an-in-process-fan-out-never-a-second-source-of-truth.md)
- [ADR-0031 — SSE resume is a bounded in-process replay ring, not durable event history](https://github.com/on-par/software-factory/blob/main/docs/adr/0031-sse-resume-is-a-bounded-in-process-replay-ring-not-durable-event-history.md)
