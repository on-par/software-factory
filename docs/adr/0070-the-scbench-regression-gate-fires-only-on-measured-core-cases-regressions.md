# ADR-0070: The SCBench regression gate fires only on measured core-cases regressions

- Status: Accepted
- Date: 2026-09-01

## Context

Issue #1135 adds `scbench-factory-agent compare`, which gates (non-zero
exit) on benchmark erosion between a retained baseline and a candidate
run. Two fail-closed/fail-open tensions had to be resolved. First:
ADR-0007 mandates that correctness derives only from retained native
SCBench evidence, and that a trial with no evaluation.json or with
infrastructure_failure is never a pass — but it says nothing about how
such trials weigh in a comparison. Second: a candidate run may simply
not cover a problem/checkpoint group the baseline covers; treating
absent coverage as a regression conflates "not measured" with "measured
worse", while ignoring it entirely would hide shrinking coverage.

## Decision

The comparison groups trials by their runs-directory location
(`<problem>/<checkpoint>`, the layout collect-trial writes) and computes
each group's core-cases pass rate fail-closed: missing-evidence and
infrastructure-failure trials stay in the denominator and never count
as passes, on both sides. The exit-code gate considers only measured
regressions — the worst per-group pass-rate drop, in percentage points,
strictly greater than the configured threshold (default 0). Groups
present on only one side, and trials without evidence, are surfaced
prominently in the report but never trip the gate by themselves,
because an unmeasured group is an unknown, not a measured regression —
the same never-infer principle ADR-0007 applies to passes, applied
symmetrically to failures.

## Consequences

Positive: the gate can never be tripped or dodged by inference — a
missing evaluation.json cannot fake a pass (it drags the rate down
inside its group), and a fabricated "regression" cannot arise from a
group nobody measured. Exit codes are deterministic functions of
retained evidence, so the command is safe to wire into CI later.
Negative: an operator who drops a whole problem from the candidate run
gets a clean exit despite reduced coverage — the report calls this out,
but a human (or future tooling) must read it; the threshold compares
pass-rate points, so with small trial counts a single trial flip can
jump the delta far past a small threshold.

## References

- [ADR-0007 — baseline correctness derives only from retained native SCBench evidence](docs/adr/0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)
- [Issue #1135](https://github.com/on-par/software-factory/issues/1135)
