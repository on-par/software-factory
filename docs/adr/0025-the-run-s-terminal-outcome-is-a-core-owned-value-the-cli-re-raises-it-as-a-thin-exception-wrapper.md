# ADR-0025: The run's terminal outcome is a core-owned value; the CLI re-raises it as a thin exception wrapper

- Status: Accepted
- Date: 2026-08-14

## Context

ParkReason and LaneParkError were defined in the CLI, and core's simulator mirrored the
same terminal-state classification into its own shape behind a "deliberate mirror, keep
in sync" comment (packages/core/src/sim/pipeline.ts). Core had no value-typed way to
express a run's terminal outcome, so the supervisor (story 4) and the simulator (story 5)
had no shared seam to switch on. Because parkReasonFor classifies LandConflictError and
CiFailedError by instanceof, moving the classification into core forces the three marker
error classes to be core-owned as well.

## Decision

Core owns the run-outcome vocabulary: packages/core/src/run/outcome.ts defines RunOutcome (shipped | ready | parked | escalated), ParkReason, ParkOutcome, Route, and the parkReasonFor/parkEvents classification, plus the LandConflictError/CiFailedError/ CiUnverifiedError marker errors, all exported from the root public API. The CLI's LaneParkError becomes a thin wrapper that carries a core ParkOutcome and re-raises it as an exception, so the supervisor's catch-based control flow is unchanged; the CLI re-exports the moved symbols instead of defining its own.

## Consequences

There is now a single source of truth for a run's terminal outcome and park classification, and the simulator's mirror is a migration target rather than a maintained duplicate (story 5). The CLI can no longer independently evolve the classification, and the core public API surface grows by the moved symbols, which is pinned by public-api.test.ts. Any new terminal state must be added to the core union, and any new park reason to ParkReason — both are now core decisions. The cost is that park classification now lives in a package that previously expressed no lane outcomes, so consumers must import it from @on-par/factory-core.

## References

- [ADR-0004 — A narrow public API for @on-par/factory-core](docs/adr/0004-narrow-public-core-api.md)
- [Issue #672](https://github.com/on-par/software-factory/issues/672)
