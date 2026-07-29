# ADR-0008: SlopCodeBench problem inputs come from a pinned scb-problems revision injected via SCBENCH_PROBLEMS_PATH

- Status: Accepted
- Date: 2026-07-29

## Context

The pinned SCBench harness commit (13de1a7a) does not contain the
benchmark problems. Its `problem_catalog.py` downloads the *latest*
GitHub release of the separate `gabeorlanski/scb-problems` repository
into a mutable per-host cache (`~/.cache/scbench`) on first use — so a
harness SHA alone leaves the actual problem definitions, and therefore
every baseline number, dependent on when and where a run happened.
ADR-0007 already requires baseline correctness to derive from retained
native evidence; that evidence is only comparable across trials if the
problems themselves are identical. The harness offers exactly one
immutable injection point: the `SCBENCH_PROBLEMS_PATH` environment
variable, which overrides the cache with a local flat directory of
problems and disables all network sync.

## Decision

The baseline pins the problem catalog as data, not as a rule.
`packages/scbench-adapter/scbench.pin.json` and
`evals/scbench-baseline/baseline.config.json` record the catalog
source (`https://github.com/gabeorlanski/scb-problems`), its release
version (v1.0), and its full commit SHA
(4d38d300059667d57e43c31969bc455f5c338b52); the two records must match
exactly. The baseline config records the resolved problem IDs as
literals — smoke `cfgpipe`; suite `cfgpipe`, `circuit_eval`,
`code_search` — never a selection rule to be evaluated at run time.
Every baseline invocation sets `SCBENCH_PROBLEMS_PATH` to a checkout
of the catalog at the pinned commit; the auto-synced `~/.cache/scbench`
catalog is never used for baseline runs. All material SCBench run
inputs (agent, model bookkeeping block, prompt policy, environment,
pass policy, thinking budget) are explicit in the committed
`scbench.run.yaml` — upstream defaults are not relied on.
`loadBaselineConfig` and `compat_check.py` fail closed when the
catalog pin, the resolved IDs, or the catalog checkout is missing or
drifted.

## Consequences

Positive: baseline trials are comparable across hosts and time — the
problem set can no longer change under us via a new upstream catalog
release; reproduction needs only committed files plus two pinned git
clones; validation catches a missing or drifted catalog before any
model budget is spent. Negative: adopting new upstream problems (or a
new catalog release) now requires a deliberate pin bump that
re-baselines, and reproduction requires one extra clone + environment
variable compared to SCBench's zero-config cache flow.

## References

- [SCBench problem catalog resolution at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/problem_catalog.py)
- [scb-problems v1.0](https://github.com/gabeorlanski/scb-problems/tree/4d38d300059667d57e43c31969bc455f5c338b52)
- [Issue #524](https://github.com/on-par/software-factory/issues/524)
