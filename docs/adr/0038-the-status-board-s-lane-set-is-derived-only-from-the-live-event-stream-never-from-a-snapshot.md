# ADR-0038: The status board's lane set is derived only from the live event stream, never from a snapshot

- Status: Accepted
- Date: 2026-08-19

## Context

#593 puts a live kanban of factory lanes in `packages/dashboard`, fed by the `GET /events` SSE
endpoint #592 added to `packages/server`. The issue forbids frontend polling, and ADR-0029 makes the
lane lifecycle bus a pure in-process fan-out with `.factory/events.ndjson` (ADR-0002) as the only
durable record — so there is no queryable "current lanes" resource, by design. ADR-0031 bounds
resume to an in-memory replay ring keyed on `Last-Event-ID`, and explicitly resolves an absent
cursor to replaying nothing. The browser's stock `EventSource` cannot send a request header on its
first connect, which means a freshly loaded page gets no backfill at all: the ring only helps on
reconnect, when the browser resends the cursor itself. That leaves a real choice. The board could
acquire a second read path — a snapshot endpoint, a directory scan of `.factory/`, or a poll — to
answer "what is running right now" independently of the stream, or it could accept the stream as
its sole input and be honest about what that means.

## Decision

The board's lane set is a fold of observed lifecycle events and nothing else. `reduceLaneEvent` in
`packages/dashboard/src/laneBoard.ts` is the only way a lane enters, leaves, or changes on the
board; `useLaneEvents` opens exactly one `EventSource` and the dashboard performs no other network
read — no snapshot fetch, no polling timer, no second source. A phase segment is `pending` until an
event names that phase, and the reducer never back-fills an earlier phase it did not observe. The
board therefore states only what it has seen: an empty board renders "Waiting for lane events…"
rather than asserting that no lanes are running, and a card's stepper shows unobserved phases as
pending rather than inferring them from a later phase's arrival. Closing the cold-start gap is a
server-side job — a snapshot route, or a replay-from-zero query parameter on `/events` that a
client can request without a header — and belongs to a `packages/server` story, not to the
frontend.

## Consequences

Positive: the frontend keeps exactly one input and one code path, so "no polling" is a structural
property rather than a rule someone has to remember; the lifecycle bus stays the single in-process
truth (ADR-0029 intact) and the NDJSON log stays the only durable record (ADR-0002 intact); the
reducer is pure and framework-free, so all board semantics are testable without a DOM or a network;
and the server keeps the narrow, loopback-authorized read-only surface ADR-0031 and ADR-0034
describe. Negative: a board opened in the middle of a run under-reports — lanes already running are
invisible until their next event, and a long-running phase can leave the board blank for minutes;
a card that first appears mid-pipeline shows its earlier phases as pending forever, which reads as
"not started" rather than "not observed"; a client offline for more than the ring's capacity gets a
gap it cannot detect (ADR-0031's existing limitation, inherited here); and the board's state is
per-tab and lost on reload. These are accepted for the localhost v1 and are the specific problems a
future snapshot endpoint should solve.

## References

- [Issue](https://github.com/on-par/software-factory/issues/593)
- [Issue](https://github.com/on-par/software-factory/issues/592)
- [ADR-0031 — SSE resume is a bounded in-process replay ring, not durable event history](https://github.com/on-par/software-factory/blob/main/docs/adr/0031-sse-resume-is-a-bounded-in-process-replay-ring-not-durable-event-history.md)
- [ADR-0029 — Lane lifecycle events are an in-process fan-out, never a second source of truth](https://github.com/on-par/software-factory/blob/main/docs/adr/0029-lane-lifecycle-events-are-an-in-process-fan-out-never-a-second-source-of-truth.md)
