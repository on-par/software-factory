# ADR-0031: SSE resume is a bounded in-process replay ring, not durable event history

- Status: Superseded by ADR-0046
- Date: 2026-08-19

## Context

#592 puts `GET /events` on `packages/server` as the live window onto the lane lifecycle
bus (#591). SSE clients (including the browser's built-in `EventSource`) reconnect on
their own and resend the last id they saw as `Last-Event-ID`, so the server has to answer
the question "what did this client miss?". The bus itself is a pure in-process
`EventEmitter` fan-out with no buffer, no ids, and no persistence — it deliberately keeps
`.factory/events.ndjson` as the canonical durable sink (ADR-0002). Full replay would
therefore mean either teaching the bus to persist or making the server read and index the
NDJSON log, and the issue explicitly does not ask for full history. The competing risk is
the opposite failure: answering an unrecognised `Last-Event-ID` with an error or a closed
socket would put a reconnecting client into a retry loop and lose the events it was
reconnecting to collect. This decision also ends the "server is a stub" convention:
`createServer()` is real from here on, scoped to this one read-only endpoint.

## Decision

The server assigns each bus event a monotonic integer id starting at 1, unique and
increasing only within a single server instance, and retains the last `replayBufferSize`
events (default 256) in an in-memory ring. `GET /events` with `Last-Event-ID: N` replays
the retained entries with id greater than N and then streams live. Every degenerate case
resolves toward keeping the stream open rather than signalling an error: a missing,
non-numeric, negative, or too-new id replays nothing; an id older than the oldest retained
entry replays the whole ring. The server never returns a non-200 status, closes the
connection, or logs a failure on account of `Last-Event-ID`. Ids are explicitly not
stable across restarts and carry no meaning outside the process that issued them, so
clients must treat them as an opaque resume cursor and never as a durable offset. The
endpoint is unauthenticated and binds `127.0.0.1` by default, which is what makes an
unauthenticated, unbounded-fan-out stream acceptable. `packages/server` consumes the bus
through an injected `LifecycleEventSource` port (structurally satisfied by core's
`LifecycleBus`) and depends only on `@on-par/contracts`, following ADR-0006's
pure-module/injected-port split.

## Consequences

Positive: reconnect works with the browser's stock `EventSource` and no client library;
a client that drops for less than 256 events loses nothing; the bus stays a
zero-buffer, zero-behavior fan-out and `.factory/events.ndjson` stays the only durable
record (ADR-0002 intact); the server package stays testable without importing core.
Negative: a client offline for more than `replayBufferSize` events silently gets a gap it
cannot detect from the stream alone; ids reset on every server restart, so a client
resuming across a restart may be replayed events it already saw (at-least-once, not
exactly-once); the ring is per-process, so this design does not survive a future
multi-process or multi-instance server without being replaced; and AGENTS.md's "the
server package is a stub, do not build features on it" convention is retired, so future
server work needs a real scope judgement rather than a blanket "don't".

## References

- [Issue #592 — SSE /events endpoint in packages/server](https://github.com/on-par/software-factory/issues/592)
- [Issue #591 — Engine event bus (the source this endpoint relays)](https://github.com/on-par/software-factory/issues/591)
- [ADR-0002 — Structured logging via the existing event log](https://github.com/on-par/software-factory/blob/main/docs/adr/0002-structured-logging-via-event-log.md)
- [ADR-0006 — Proposer export is pure; filing goes through an injected port](https://github.com/on-par/software-factory/blob/main/docs/adr/0006-proposer-export-is-pure-github-filing-goes-through-an-injected-port.md)
