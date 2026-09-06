# ADR-0083: The committed SCBench baseline runs tree holds only live trials; report status expresses comparison-readiness, not measurability

- Status: Accepted
- Date: 2026-09-01

## Context

The first committed baseline report was labeled PRELIMINARY and its pass rate was diluted
by two deterministic stub trials (zero cost, no native evidence) that had been committed
under `evals/scbench-baseline/runs/smoke/` purely to prove the adapter → manifest → report
wiring. Once live, model-backed cfgpipe evidence landed (#1064/#1158), those stubs made the
measured pass rate misrepresent reality (3/6 instead of 3/4) and the generator's
below-threshold banner conflated two independent axes: whether the pass rate is _measurable_
(an evidence property — ADR-0007 already derives correctness only from retained
`evaluation.json` under the pinned `core-cases` policy) and whether the trial count meets the
10-trial _comparison_ threshold (a statistical bar for comparing configurations).

## Decision

`evals/scbench-baseline/runs/` contains only live, model-backed trials. Deterministic stub
trials are test material and live in `packages/scbench-adapter` (run-checkpoint tests and
the collect-trial fixtures), never in the baseline runs tree, so they can never enter a
measured pass-rate denominator. The report's status banner expresses only
comparison-readiness: below the threshold it reads "Status: below comparison threshold"
with the recorded/required trial counts and full configuration scope; at or above it,
"Status: comparison-ready". Measurability is asserted solely by the benchmark pass-rate
section, which derives from native SCBench evidence and fails closed (missing evidence and
infrastructure failures are never passes) per ADR-0007. The words "PRELIMINARY" and
"not measurable" do not appear in a report that carries evidence-derived results.

## Consequences

The committed pass rate reflects real trial data only, and a below-threshold report can no
longer be mistaken for an unmeasured one. The trade-off is that an under-threshold report
reads more authoritative than before; the explicit trial-count banner and the retained
10-trial comparison gate mitigate that. Stub artifacts are no longer browsable in the
baseline tree (git history and the package fixtures retain them). Future trial collection
must keep the runs tree live-only — a stub or rehearsal run must never be collected into
`evals/scbench-baseline/runs/`.

## References

- [ADR-0007 — baseline correctness derives only from retained native SCBench evidence](https://github.com/on-par/software-factory/blob/main/docs/adr/0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)
- [Issue #1068](https://github.com/on-par/software-factory/issues/1068)
