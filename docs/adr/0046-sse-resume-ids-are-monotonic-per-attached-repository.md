# ADR-0046: SSE resume IDs are monotonic per attached repository

- Status: Accepted
- Date: 2026-08-25

## Context

ADR-0031 defined a single server-wide increasing SSE ID before the server supported
multiple attached repositories. Repository-filtered subscriptions now need cursors that
remain meaningful when events from other repositories interleave, and issue #840
establishes that IDs are monotonic within each repository rather than globally across the
firehose. Retention remains a bounded in-process ring; only event-ID allocation and replay
interpretation need to change.

## Decision

The server allocates integer SSE IDs independently for each attached repository, beginning
at 1. A numeric `Last-Event-ID` is interpreted as a repository-local watermark for every
retained event: replay includes an entry only when its own repository-local ID is greater
than the cursor. The replay ring remains globally bounded and retains arrival order, while
every event envelope continues to carry its repository slug.

This ADR supersedes only ADR-0031's server-global ID allocation clause; its bounded
in-process replay decision remains in effect.

## Consequences

Filtered streams can reconnect without unrelated repository traffic advancing their cursor,
and a filtered cursor can be used when reconnecting to the firehose. Firehose frames can
contain duplicate numeric IDs across repositories, so clients must use the repo envelope
field to distinguish them and cannot treat the scalar cursor as a globally ordered offset.

## References

- [Issue #840 — Preserve multi-repository SSE resume semantics](https://github.com/on-par/software-factory/issues/840)
- [ADR-0031 — SSE resume is a bounded in-process replay ring, not durable event history](https://github.com/on-par/software-factory/blob/main/docs/adr/0031-sse-resume-is-a-bounded-in-process-replay-ring-not-durable-event-history.md)
