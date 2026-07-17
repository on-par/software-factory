# ADR-0002: Structured logging via the existing event log, not pino

- Status: Accepted
- Date: 2026-07-17

## Context

Factory runtime output (issue #145) needed structured, leveled log records —
every log line carrying `lane`, `issue`, `phase`, and `level` fields — so an
operator can filter an unattended run's output at 3am. Two things were
already in place: `logEvent()` in `packages/core/src/utils/index.ts` appends
NDJSON `FactoryEvent`s to `.factory/events.ndjson`, and `formatEventLine()`
pretty-prints a colored `[factory] ...` console line from the same event. What
was missing was `level`/`lane`/`phase` fields on the event record, a
first-class logger API with bound context, and migration of the handful of
bare `console.log`/`console.error` runtime lines in the CLI that bypassed the
event stream entirely.

The obvious off-the-shelf answer is a logging library such as pino. But
`packages/core/src/utils/format.ts` already documents a deliberate
zero-new-dependency stance for this exact log path, and AGENTS.md pins core's
dependency list to `execa`, `@octokit/rest`, `gray-matter`, and `zod`. Adding
pino would also duplicate `.factory/events.ndjson`, which already is a
structured, appendable, machine-readable sink — a second structured stream
alongside it would just be two sources of truth for the same data.

## Decision

Extend the existing `.factory/events.ndjson` event log into the canonical
structured sink, with a zero-dependency `createLogger` in
`packages/core/src/logger/`, rather than adopting pino.

- `FactoryEvent` gains additive, optional `level`, `lane`, and `phase` fields
  (`packages/core/src/types/index.ts`) — old NDJSON files and readers keep
  parsing unchanged.
- `createLogger(eventsFile, ctx, opts)` returns a `FactoryLogger` with
  `debug`/`info`/`warn`/`error` methods and a `child(ctx)` for merging bound
  context (lane/issue/phase). Every call always appends a full NDJSON line to
  the events file — the file is the complete machine-readable record,
  regardless of console verbosity.
- Console output stays pretty by default (`formatEventLine`, now lane-aware);
  `FACTORY_LOG_FORMAT=json` switches stdout to the same NDJSON line instead.
  `FACTORY_LOG_LEVEL` (default `info`) filters console verbosity only — it
  never affects what's written to the file.
- `logEvent()` becomes a thin compatibility wrapper over `createLogger`, so
  existing call sites and `typeof logEvent`-typed test injections keep
  working unchanged.
- The CLI threads `lane`/`phase` context through `shipIssue`'s per-phase
  loggers and replaces its remaining bare `console.log`/`console.error`
  runtime lines with `logEvent` calls, so those lines reach the NDJSON file
  too.

## Consequences

Positive:

- No new dependency; core's pinned dep list is untouched.
- Old `.factory/events.ndjson` files and readers (`readEvents`/`followEvents`)
  keep working — the new fields are strictly additive and optional.
- The TUI fallback renderer (`packages/tui/src/fallback.ts`) keeps working
  via the backward-compatible `formatEventLine`.
- A future OTel or log-shipping integration has one obvious place to read
  from: the NDJSON file, not a second stream.

Negative / accepted trade-offs:

- No batching, sampling, or transport features that a library like pino
  provides — acceptable because this is a local CLI process, not a service.
- `createLogger`'s console formatting logic lives in-repo instead of being
  battle-tested library code; it's small enough (`packages/core/src/logger/`,
  `packages/core/src/utils/format.ts`) to keep reading and maintaining
  directly.
