# Ship-Phase Duration Breakdown (Issue #1328)

Date: 2026-09-08

## Context

Issue #1328 asks to "measure and break down the ship wall" — where does the
time in a `factory ship` run actually go, phase by phase? PR #1324 (merged
same day, `99b81ab`) already made `phase_started`/`phase_completed` and
`checker_started`/`checker_completed` events carry ISO `ts` and `durationMs`.
Three gaps remained before that instrumentation could answer the question:

1. PLAN's ADR-constraint injection (`readAdrContext`/`renderAdrConstraints` in
   `packages/core/src/phases/plan.ts`) ran with no start/end event at all, so
   its cost was invisible inside PLAN's own duration.
2. The headless sim harness (`packages/core/src/sim/pipeline.ts`) — real
   PLAN/BUILD/CHECK/SHIP phase code against fake model/GitHub doubles, no
   network — discarded `durationMs` (and had no `ts`) in its `log()` closure,
   so it could not stand in as a reproducible, real-code source of duration
   data.
3. Nothing aggregated `phase_completed`/`checker_completed`/
   `adr_inject_completed` events into a breakdown. There is no historical
   SB#1395-style scoreboard log for this on disk anywhere in this checkout or
   any sibling repo (confirmed by search) to mine instead.

This note records a real reproduction of the fixed pipeline and what it shows.

## What changed

- `plan.ts` now emits `adr_inject_started` before, and `adr_inject_completed`
  (with `durationMs`) after, the existing ADR-context block.
- `sim/pipeline.ts`'s `log()` closure now stamps every event with `ts` and
  forwards `extra.durationMs` instead of dropping it, so `SimPipelineEvent`
  carries the same `{ ts, type, durationMs }` shape as a real
  `.factory/events.ndjson` line.
- `packages/core/src/reports/ship-phase-breakdown.ts` adds a pure
  `renderShipPhaseBreakdown()` (plus `aggregateShipPhaseBreakdown()`), exported
  from the package root per ADR-0004. It sums `phase_completed` durations per
  phase, `checker_completed` durations per checker (parsed off the message),
  and `adr_inject_completed` durations, and renders a markdown table — no I/O,
  same shape whether fed real events or sim events.
- `packages/core/src/sim/ship-phase-breakdown-cli.ts` (testing-only export)
  runs one clean sim reproduction via `runSimulation` and renders its captured
  events through `renderShipPhaseBreakdown()`. `scripts/ship-phase-breakdown-report.ts`
  is the three-line entrypoint, modeled on `scripts/sim-monte-carlo.ts`; wired
  up as `npm run ship-phase-breakdown-report`.

## Reproduction

Machine: `Darwin Patricks-Mac-mini 25.6.0` (arm64), Node `v26.6.0`. Run from
this checkout at `99b81ab` plus the above changes:

```
$ npm run ship-phase-breakdown-report
```

Real captured output (exit code 0 — the sim reproduction shipped):

```
# Ship-phase duration breakdown

- Total measured phase duration: 279ms
- ADR injection (subset of PLAN): 1ms

## By phase

| phase | durationMs | % of total | count |
| --- | --- | --- | --- |
| ship | 115 | 41.2% | 1 |
| build | 102 | 36.6% | 1 |
| check | 59 | 21.1% | 1 |
| plan | 3 | 1.1% | 1 |

## By checker (subset of CHECK)

| checker | durationMs | count |
| --- | --- | --- |
| worker_output | 29 | 1 |
| design_smells | 29 | 1 |
| compile | 0 | 1 |
| tests | 0 | 1 |
| lint | 0 | 1 |
| links | 0 | 1 |
| accessibility | 0 | 1 |
```

A second run (same command, moments later) reproduced the same shape with
different absolute numbers — `total 304ms`, `ship 125ms (41.1%)`,
`build 110ms (36.2%)`, `check 65ms (21.4%)`, `plan 4ms (1.3%)`, and
`ADR injection 0ms` — confirming the breakdown is driven by real per-run
timing (down to sub-millisecond scheduling jitter for the near-instant sim
doubles), not a fixture.

## Findings

- **The instrumentation is now end-to-end.** Every phase, every checker, and
  PLAN's ADR injection step now has a `durationMs`-bearing start/end event
  pair, and both real (`events.ndjson`) and sim-harness event streams satisfy
  the same shape the aggregator consumes.
- **Relative phase shape in this reproduction**: SHIP and BUILD dominate
  (~41% and ~37%), CHECK is ~21%, and PLAN — even including ADR injection —
  is under 2%. `design_smells` and `worker_output` are the only checkers with
  non-zero cost in this run; the rest (`compile`, `tests`, `lint`, `links`,
  `accessibility`) are no-ops against the sim's throwaway workspace and round
  to 0ms.
- **Caveat — this is not a production ship-wall number.** The sim harness
  runs real phase/checker _code_ but against fake model and GitHub doubles
  with no injected latency, so every millisecond here is scheduling/IO
  overhead in this repo's own code, not real LLM inference or network time.
  In a real `factory ship` run, PLAN/BUILD/CHECK are each dominated by one or
  more model-provider round trips (seconds to minutes each, per the existing
  `docs/research/local-only-baseline-run.md` baseline: a real run measured in
  the 2-minute range end to end), so the _proportions_ above will not
  transfer directly. What does transfer is the breakdown mechanism itself:
  point `renderShipPhaseBreakdown()` at a real run's `.factory/events.ndjson`
  slice (e.g. via `readIssueEvents` from `reports/local-run.ts`, which already
  filters by issue and start time) to get the real per-phase/per-checker
  wall-clock split for that run.
- **ADR injection is cheap.** At 0-1ms in a workspace with no `docs/adr`
  directory, ADR injection is not a meaningful contributor to PLAN's own
  duration in the common case; a checkout with a large ADR corpus would be
  the case worth re-measuring if PLAN duration is ever the bottleneck under
  investigation.

## Next steps (not in scope here)

- Run `renderShipPhaseBreakdown()` against a real `factory ship` run's event
  slice once one is available, to get production-representative proportions.
- If checker cost becomes a target for optimization, the per-checker table
  already isolates which checker to look at first (`design_smells` and
  `worker_output` are the two agent-based checkers here, unsurprisingly the
  only non-zero ones against a no-op sim workspace).
