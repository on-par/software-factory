# ADR-0029: Lane lifecycle events are an in-process fan-out, never a second source of truth

- Status: Accepted
- Date: 2026-08-19

## Context

ADR-0002 makes `.factory/events.ndjson` the canonical structured sink: every phase
already reports progress through an injected `log` callback that appends a durable
NDJSON line. Epic #583 needs something that file cannot give an embedding consumer -
a synchronous, in-process subscription to lane progress that `packages/server` can
attach to without tailing a file. Adding a second event channel invites two failure
modes: consumers treating the bus as durable (it is not - no persistence, no replay,
no delivery guarantee), and instrumentation acquiring the power to change pipeline
behavior, which issue #591 explicitly forbids. The schema also has to be shared
rather than duplicated, and this repo already has a package for exactly that: the
zero-I/O `@on-par/contracts` typed seam that owns DesignArtifact.

## Decision

The lifecycle bus is an additive, in-process, fire-and-forget fan-out and never a
source of truth. `.factory/events.ndjson` remains canonical under ADR-0002; the bus
duplicates a strict subset of that signal for consumers embedded in the same
process, and no code may read state back from it.

The event schema lives in `@on-par/contracts` (`LaneLifecycleEventSchema` /
`LaneLifecycleEvent`), because the schema is a shared typed seam and the bus
implementation is engine runtime. The bus itself lives in
`packages/core/src/bus/index.ts` and is re-exported from core's narrow public API
per ADR-0004, so `packages/server` and other consumers import one declaration.

Emission is wrapped, not scattered: each phase entry point delegates to
`withLifecycle()`, which emits exactly one `started` event before the phase body and
exactly one `done` or `failed` event after it settles - including when it throws,
after which the error is re-thrown unchanged. Subscriber callbacks are invoked
inside try/catch, so a throwing or slow subscriber can never alter a phase's result,
control flow, or the errors it surfaces. Any phase added to the pipeline later must
be wrapped the same way.

## Consequences

Positive: consumers get lane progress without file tailing; the four phases keep one
emission site each, so a phase cannot emit a duplicated or missing terminal event;
the shape is validated by one zod schema no consumer redeclares; instrumentation is
provably unable to change pipeline behavior.

Negative: events are lost if no subscriber is attached when a phase runs (no replay
or buffering), so the bus is unusable for audit or recovery - those readers must
keep using the event log; the same signal now exists in two places and can drift if
a future phase logs without being wrapped; a swallowed subscriber error is invisible
unless that subscriber logs it itself; and the wrapper adds one indirection between
the exported phase name and its implementation.

## References

- [Issue #591 - Engine event bus: emit lifecycle events per lane/phase](https://github.com/on-par/software-factory/issues/591)
- [ADR-0002 - Structured logging via the existing event log](https://github.com/on-par/software-factory/blob/main/docs/adr/0002-structured-logging-via-event-log.md)
