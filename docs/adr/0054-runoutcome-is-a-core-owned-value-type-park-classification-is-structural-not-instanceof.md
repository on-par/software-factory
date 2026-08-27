# ADR-0054: RunOutcome is a core-owned value type; park classification is structural, not instanceof

- Status: Accepted
- Date: 2026-08-27

## Context

ParkReason, LaneParkError, and the parkReasonFor/parkEvents classification were
CLI-owned, and core's sim/pipeline.ts hand-mirrored the same terminal-state mapping
into a second type system kept in sync only by a comment. Epic #670 (stories 2–6)
needs a single core-owned value type for a run's terminal outcome that both the CLI
supervisor and the sim can converge on. But core cannot import the CLI's error
classes (LandConflictError, CiFailedError, LaneParkError), and those classes are
thrown from many CLI ship/land sites, so relocating them is out of scope. The
classification therefore has to cross the core→CLI boundary without an `instanceof`
on CLI types.

## Decision

Core owns ParkReason and a RunOutcome discriminated union (shipped | ready | parked
| escalated) in packages/core/src/run/outcome.ts, and owns parkReasonFor/parkEvents.
Core classifies STRUCTURALLY rather than by instanceof: it reads a parked RunOutcome
off `err.outcome` (which LaneParkError now carries) and a `readonly parkReason`
marker off the CLI's own error classes, then falls back to the pre-existing
reason==='timeout' / 'fail' rules. The CLI keeps LaneParkError as a thin wrapper that
builds `{ state:'parked', reason }` internally and re-raises it, and re-exports the
core functions so its public surface is unchanged.

## Consequences

Positive: one value-typed terminal-outcome vocabulary in core that later stories
re-point the sim and supervisor onto; the CLI/core boundary stays acyclic; adding a
new parkable CLI error only requires a marker property. Negative: classification now
depends on a structural `parkReason`/`outcome` convention that a future maintainer
could regress by re-introducing instanceof or by omitting a marker — the core tests
pin the mapping to guard against that. The sim mirror is deliberately left in place
until story 5.

## References

- [Issue](https://github.com/on-par/software-factory/issues/672)
- [ADR-0004 — A narrow public API for @on-par/factory-core](docs/adr/0004-narrow-public-core-api.md)
