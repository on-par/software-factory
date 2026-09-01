# SlopCodeBench Baseline: scbench-baseline-2026-07

**Trial count:** 6 (comparison threshold: 10)

**Status: PRELIMINARY** — only 6 of the required 10 trials per configuration have been recorded. Configuration scope: baseline `scbench-baseline-2026-07`, factory commit `6c74eeea2a7b114c86ffd85a3749824c5c6bdd91`, scbench commit `13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7`, problem catalog commit `4d38d300059667d57e43c31969bc455f5c338b52`, model config env: FACTORY_LOCAL_ONLY=unset, FACTORY_EXPERIMENTAL=unset.

## Pinned inputs

- Factory: `https://github.com/on-par/software-factory` @ `6c74eeea2a7b114c86ffd85a3749824c5c6bdd91` (package v2.0.0)
- SlopCodeBench: `https://github.com/SprocketLab/slop-code-bench` @ `13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7` (pinned 2026-07-28)
- Model config: packages/config/src/defaults.ts (typed model registry and routes) at factory.commit; env: FACTORY_LOCAL_ONLY=unset, FACTORY_EXPERIMENTAL=unset
- Prompt inputs: Checkpoint briefs are produced by materializeBrief in @on-par/scbench-adapter at factory.commit; phase prompts/constitutions are those shipped in @on-par/factory-config at factory.commit
- Environment: node >=24; binaries: git, claude, node; host: macOS arm64 (Darwin 25.x) — record actual host in each live run's manifest; harness: Python per upstream README at the pinned SCBench commit
- Problem catalog: `https://github.com/gabeorlanski/scb-problems` @ `4d38d300059667d57e43c31969bc455f5c338b52` (release v1.0, pinned 2026-07-29) — every run sets SCBENCH_PROBLEMS_PATH to a checkout of this revision
- Problems: smoke `cfgpipe`; suite `cfgpipe`, `circuit_eval`, `code_search` (problemCatalog.commit — the lexicographically first (smoke) and first three (suite) problem ids among the catalog checkout's direct child directories containing config.yaml, resolved 2026-07-29 and frozen here as literals)
- Trial plan: 2 smoke run(s), 3 suite trial(s) per problem
- Pass policy: `core-cases` — Upstream PassPolicy.CORE_CASES at the pinned SCBench commit: a checkpoint passes iff every Core-group test in its native evaluation.json passes (pass_counts.Core === total_counts.Core). Evidence guards: infrastructure_failure === true or missing evaluation.json is never a pass.

## Trials

- `cfgpipe/checkpoint_1/trial-1`: outcome `ready`, elapsed 248403ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_1/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_2/trial-1`: outcome `ready`, elapsed 217388ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_2/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_3/trial-1`: outcome `ready`, elapsed 255919ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_3/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_4/trial-1`: outcome `ready`, elapsed 619510ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_4/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `smoke/trial-1`: outcome `ready`, elapsed 60000ms, manifest `evals/scbench-baseline/runs/smoke/trial-1/manifest.json`, native evidence: none
- `smoke/trial-2`: outcome `ready`, elapsed 60000ms, manifest `evals/scbench-baseline/runs/smoke/trial-2/manifest.json`, native evidence: none

## Benchmark pass rate (native SCBench evaluation)

3/6 (50.0%) under pass policy `core-cases` — 3 pass, 1 fail, 0 infrastructure failure, 2 missing evidence. A trial without native evaluation evidence never counts as a pass.

- `cfgpipe/checkpoint_1/trial-1`: pass — Core 4/4 (cfgpipe / checkpoint_1)
- `cfgpipe/checkpoint_2/trial-1`: pass — Core 3/3 (cfgpipe / checkpoint_2)
- `cfgpipe/checkpoint_3/trial-1`: pass — Core 4/4 (cfgpipe / checkpoint_3)
- `cfgpipe/checkpoint_4/trial-1`: fail — Core 6/7 (cfgpipe / checkpoint_4)
- `smoke/trial-1`: missing evidence — no evaluation.json in the trial directory
- `smoke/trial-2`: missing evidence — no evaluation.json in the trial directory

## Erosion trajectory (native SCBench evaluation)

- cfgpipe: checkpoint_1 `cfgpipe/checkpoint_1/trial-1`: pass (Core 4/4), checkpoint_2 `cfgpipe/checkpoint_2/trial-1`: pass (Core 3/3), checkpoint_3 `cfgpipe/checkpoint_3/trial-1`: pass (Core 4/4), checkpoint_4 `cfgpipe/checkpoint_4/trial-1`: fail (Core 6/7)

## Factory run outcomes (harness health)

6/6 (100.0%) of Factory runs ended `ready`. This is harness health — a `ready` manifest means the PLAN → BUILD → CHECK pipeline completed, not that SCBench's checkpoint evaluation passed; benchmark correctness above is derived only from native SCBench evidence.

## Elapsed time

Total elapsed: 1461220ms across 6 trial(s); mean 243536.7ms.

## Cost

Total cost: $8.8681; input tokens: 5231287; output tokens: 113550.

## Routing and failover

- claude-fable-5 / plan: 4 attempt(s)
- claude-sonnet-5 / build_claude: 4 attempt(s)

## Provider policy

Declared policy (source: packages/config/src/defaults.ts (typed model registry and routes) at factory.commit): approved models `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`; disabled providers: `ollama`

- `cfgpipe/checkpoint_1/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_2/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_3/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_4/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `smoke/trial-1`: no model attempts recorded — provider evidence unavailable
- `smoke/trial-2`: no model attempts recorded — provider evidence unavailable

Ollama disabled: not confirmable from recorded evidence — 2 trial(s) recorded no model attempts. A trial without recorded attempts never counts as confirmation.

## Checker outcomes

- `cfgpipe/checkpoint_1/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_2/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_3/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_4/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `smoke/trial-1`: No checker data (run ended before CHECK or checker summary absent).
- `smoke/trial-2`: No checker data (run ended before CHECK or checker summary absent).

## Failure notes

No failures recorded.

## Reproduction

See `evals/scbench-baseline/README.md` for the exact commands to reproduce the live smoke and small-suite runs and to regenerate this report. Every number above is derived from the trial manifests listed in the Trials section — none is hand-transcribed.
