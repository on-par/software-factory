# SlopCodeBench Baseline: scbench-baseline-2026-07

**Trial count:** 2 (comparison threshold: 10)

**Status: PRELIMINARY** — only 2 of the required 10 trials per configuration have been recorded. Configuration scope: baseline `scbench-baseline-2026-07`, factory commit `6c74eeea2a7b114c86ffd85a3749824c5c6bdd91`, scbench commit `13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7`, problem catalog commit `4d38d300059667d57e43c31969bc455f5c338b52`, model config env: FACTORY_LOCAL_ONLY=unset, FACTORY_EXPERIMENTAL=unset.

## Pinned inputs

- Factory: `https://github.com/on-par/software-factory` @ `6c74eeea2a7b114c86ffd85a3749824c5c6bdd91` (package v2.0.0)
- SlopCodeBench: `https://github.com/SprocketLab/slop-code-bench` @ `13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7` (pinned 2026-07-28)
- Model config: packages/config/src/models.json and packages/config/src/routes.json at factory.commit; env: FACTORY_LOCAL_ONLY=unset, FACTORY_EXPERIMENTAL=unset
- Prompt inputs: Checkpoint briefs are produced by materializeBrief in @on-par/scbench-adapter at factory.commit; phase prompts/constitutions are those shipped in @on-par/factory-config at factory.commit
- Environment: node >=24; binaries: git, claude, node; host: macOS arm64 (Darwin 25.x) — record actual host in each live run's manifest; harness: Python per upstream README at the pinned SCBench commit
- Problem catalog: `https://github.com/gabeorlanski/scb-problems` @ `4d38d300059667d57e43c31969bc455f5c338b52` (release v1.0, pinned 2026-07-29) — every run sets SCBENCH_PROBLEMS_PATH to a checkout of this revision
- Problems: smoke `cfgpipe`; suite `cfgpipe`, `circuit_eval`, `code_search` (problemCatalog.commit — the lexicographically first (smoke) and first three (suite) problem ids among the catalog checkout's direct child directories containing config.yaml, resolved 2026-07-29 and frozen here as literals)
- Trial plan: 2 smoke run(s), 3 suite trial(s) per problem
- Pass policy: `core-cases` — Upstream PassPolicy.CORE_CASES at the pinned SCBench commit: a checkpoint passes iff every Core-group test in its native evaluation.json passes (pass_counts.Core === total_counts.Core). Evidence guards: infrastructure_failure === true or missing evaluation.json is never a pass.

## Trials

- `smoke/trial-1`: outcome `ready`, elapsed 60000ms, manifest `evals/scbench-baseline/runs/smoke/trial-1/manifest.json`, native evidence: none
- `smoke/trial-2`: outcome `ready`, elapsed 60000ms, manifest `evals/scbench-baseline/runs/smoke/trial-2/manifest.json`, native evidence: none

## Benchmark pass rate (native SCBench evaluation)

Not measurable — none of the 2 recorded trial(s) carries native SCBench evaluation evidence (`evaluation.json`). Factory run outcomes are reported separately under harness health and are never counted as benchmark passes.

## Erosion trajectory (native SCBench evaluation)

Not yet measurable — requires native SCBench evaluation evidence from the live multi-checkpoint suite run.

## Factory run outcomes (harness health)

2/2 (100.0%) of Factory runs ended `ready`. This is harness health — a `ready` manifest means the PLAN → BUILD → CHECK pipeline completed, not that SCBench's checkpoint evaluation passed; benchmark correctness above is derived only from native SCBench evidence.

## Elapsed time

Total elapsed: 120000ms across 2 trial(s); mean 60000.0ms.

## Cost

Total cost: $0.0000; input tokens: 0; output tokens: 0.

## Routing and failover

No routing or failover events recorded.

## Checker outcomes

- `smoke/trial-1`: No checker data (run ended before CHECK or checker summary absent).
- `smoke/trial-2`: No checker data (run ended before CHECK or checker summary absent).

## Failure notes

No failures recorded.

## Reproduction

See `evals/scbench-baseline/README.md` for the exact commands to reproduce the live smoke and small-suite runs and to regenerate this report. Every number above is derived from the trial manifests listed in the Trials section — none is hand-transcribed.
