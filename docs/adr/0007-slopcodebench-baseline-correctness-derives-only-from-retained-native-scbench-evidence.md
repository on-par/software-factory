# ADR-0007: SlopCodeBench baseline correctness derives only from retained native SCBench evidence

- Status: Accepted
- Date: 2026-07-29

## Context

Factory's SlopCodeBench baseline (#504/#510/#511) originally reported
"checkpoint pass rate" from Factory's own `BenchmarkManifest`
`run.outcome === 'ready'`. A `ready` outcome means the PLAN → BUILD →
CHECK pipeline completed — it says nothing about whether SCBench's
hidden checkpoint evaluation passed, so the baseline could overstate
benchmark correctness. The pinned SCBench runner (commit `13de1a7`,
`SprocketLab/slop-code-bench`) natively emits per-checkpoint
`evaluation.json` (CorrectnessResults: `pass_counts`/`total_counts` by
group, `infrastructure_failure`, `pytest_exit_code`), a run-level
`checkpoint_results.jsonl`, and `run_info.yaml` (resolved run spec +
execution summary). Benchmark claims must be reproducible from committed
evidence, and the two kinds of signal — benchmark correctness vs.
Factory harness health — must never be conflated.

## Decision

The baseline artifact contract retains SCBench's native outputs verbatim,
colocated in each trial directory next to `manifest.json`:
`evaluation.json`, `checkpoint_results.jsonl`, and `run_info.yaml`.
`baseline.config.json` records an explicit pinned pass policy
(`passPolicy.id: "core-cases"`, mirroring upstream
`PassPolicy.CORE_CASES` at the pinned commit: all Core-group tests
pass). The report generator derives benchmark pass rate and erosion
exclusively from the retained `evaluation.json` files under that policy;
a trial with `infrastructure_failure: true` or with no retained
evaluation evidence is never counted as a benchmark pass. Factory
manifest outcome, checker state, routing, and cost are reported only as
harness-health metrics, explicitly labeled as such. Native evidence is
never transcribed, normalized, or synthesized by the adapter — only
copied by the operator from SCBench's own output tree.

## Consequences

Positive: the baseline can no longer overstate benchmark correctness; a
report claim is reproducible byte-for-byte from committed native
evidence; harness health and benchmark correctness stay independently
visible; the pinned policy makes cross-run comparisons well-defined.
Negative: the committed stub trials (wiring evidence only) now render a
"not measurable" benchmark section until live evidence lands; operators
must copy three extra files per trial when preserving live runs; the
evidence readers are coupled to the pinned SCBench commit's file formats
and must be revisited if the pin moves.

## References

- [SCBench checkpoint-results doc at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/docs/metrics/checkpoint-results.md)
- [SCBench run-results doc at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/docs/metrics/run-results.md)
- [Issue #523](https://github.com/on-par/software-factory/issues/523)
