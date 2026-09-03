# ADR-0071: SCBench rework is a bounded adapter re-invocation of run-brief, not a core pipeline hook

- Status: Accepted
- Date: 2026-09-01

## Context

Issue #1163 asks Factory to feed failed SCBench evaluation evidence into a
targeted rework attempt, and named core's check.ts/run-issue.ts as likely
touch points. But SCBench's hidden evaluation runs only after the adapter's
run-checkpoint process has returned and committed the workspace — core's
in-run rework loop (ADR-0017's seam) structurally cannot observe
evaluation.json for the run it is part of. Meanwhile ADR-0007 requires
first-attempt native evidence to remain retained verbatim, and the issue
rules out unlimited retry loops.

## Decision

SCBench rework happens outside core: the adapter's `retry-checkpoint`
subcommand parses the failed checkpoint's evaluation.json into a structured
retry context, renders a rework brief (original checkpoint task verbatim
plus the concrete failing test names and any stdout/stderr excerpts), and
re-invokes `factory run-brief` — the same full pipeline as the first
attempt. All retry artifacts, including retry-context.json and the rework
brief, land in a `rework-1/` subdirectory of the checkpoint's artifacts
directory; the first-attempt directory is never written to. Exactly one
retry is recordable per checkpoint: an existing rework-1 manifest fails the
command closed. Infrastructure failures and passing evaluations are never
retried.

## Consequences

Positive: core's phase/port surface stays benchmark-agnostic; first-attempt
vs rework evidence is distinguishable by directory layout without changing
the baseline report, collectTrial, or the trial-directory contract (they
read only the fixed named files and never descend into rework-1/); the
retry bound is structural, not a counter that can drift. Negative: rework
quality depends entirely on prompt enrichment — the rework run gets no
machine-readable failure channel into core's checkers; and a second rework
attempt requires a deliberate future decision (a rework-2 layout plus a
policy), which is the intended friction. Future code that wants deeper
SCBench↔core integration must revisit this ADR rather than threading
evidence through run-issue ports ad hoc.

## References

- [ADR-0007 — baseline correctness derives only from retained native
  SCBench evidence](0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)
