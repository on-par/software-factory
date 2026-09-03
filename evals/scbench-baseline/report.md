# SlopCodeBench Baseline: scbench-baseline-2026-07

**Trial count:** 12 (comparison threshold: 10)

**Status: comparison-ready** — the trial count meets the comparison threshold.

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
- `cfgpipe/checkpoint_1/trial-2`: outcome `ready`, elapsed 232863ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_1/trial-2/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_1/trial-3`: outcome `ready`, elapsed 185168ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_1/trial-3/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_2/trial-1`: outcome `ready`, elapsed 217388ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_2/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_2/trial-2`: outcome `ready`, elapsed 251020ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_2/trial-2/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_2/trial-3`: outcome `ready`, elapsed 204545ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_2/trial-3/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_3/trial-1`: outcome `ready`, elapsed 255919ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_3/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_3/trial-2`: outcome `ready`, elapsed 302076ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_3/trial-2/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_3/trial-3`: outcome `ready`, elapsed 236623ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_3/trial-3/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_4/trial-1`: outcome `ready`, elapsed 619510ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_4/trial-1/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_4/trial-2`: outcome `ready`, elapsed 704581ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_4/trial-2/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml
- `cfgpipe/checkpoint_4/trial-3`: outcome `ready`, elapsed 698738ms, manifest `evals/scbench-baseline/runs/cfgpipe/checkpoint_4/trial-3/manifest.json`, native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml

## Benchmark pass rate (native SCBench evaluation)

9/12 (75.0%) under pass policy `core-cases` — 9 pass, 3 fail, 0 infrastructure failure, 0 missing evidence. A trial without native evaluation evidence never counts as a pass. all-groups: 0/12 — a trial counts only when every test group (Core, Functionality, Regression, Error) passes; missing evidence or an infrastructure failure is never counted as an all-groups pass.

- `cfgpipe/checkpoint_1/trial-1`: pass — Core 4/4, Functionality 20/20, Regression none, Error 9/13 (cfgpipe / checkpoint_1) — all-groups: fail
- `cfgpipe/checkpoint_1/trial-2`: pass — Core 4/4, Functionality 20/20, Regression none, Error 9/13 (cfgpipe / checkpoint_1) — all-groups: fail
- `cfgpipe/checkpoint_1/trial-3`: pass — Core 4/4, Functionality 20/20, Regression none, Error 9/13 (cfgpipe / checkpoint_1) — all-groups: fail
- `cfgpipe/checkpoint_2/trial-1`: pass — Core 3/3, Functionality 15/15, Regression 33/37, Error 8/13 (cfgpipe / checkpoint_2) — all-groups: fail
- `cfgpipe/checkpoint_2/trial-2`: pass — Core 3/3, Functionality 15/15, Regression 33/37, Error 9/13 (cfgpipe / checkpoint_2) — all-groups: fail
- `cfgpipe/checkpoint_2/trial-3`: pass — Core 3/3, Functionality 15/15, Regression 33/37, Error 8/13 (cfgpipe / checkpoint_2) — all-groups: fail
- `cfgpipe/checkpoint_3/trial-1`: pass — Core 4/4, Functionality 11/13, Regression 59/68, Error 18/22 (cfgpipe / checkpoint_3) — all-groups: fail
- `cfgpipe/checkpoint_3/trial-2`: pass — Core 4/4, Functionality 11/13, Regression 60/68, Error 19/22 (cfgpipe / checkpoint_3) — all-groups: fail
- `cfgpipe/checkpoint_3/trial-3`: pass — Core 4/4, Functionality 11/13, Regression 59/68, Error 18/22 (cfgpipe / checkpoint_3) — all-groups: fail
- `cfgpipe/checkpoint_4/trial-1`: fail — Core 6/7, Functionality 16/17, Regression 92/107, Error 4/6 (cfgpipe / checkpoint_4) — all-groups: fail
- `cfgpipe/checkpoint_4/trial-2`: fail — Core 6/7, Functionality 16/17, Regression 94/107, Error 4/6 (cfgpipe / checkpoint_4) — all-groups: fail
- `cfgpipe/checkpoint_4/trial-3`: fail — Core 6/7, Functionality 17/17, Regression 92/107, Error 4/6 (cfgpipe / checkpoint_4) — all-groups: fail

## Erosion trajectory (native SCBench evaluation)

- cfgpipe: checkpoint_1 `cfgpipe/checkpoint_1/trial-1`: pass (Core 4/4), checkpoint_1 `cfgpipe/checkpoint_1/trial-2`: pass (Core 4/4), checkpoint_1 `cfgpipe/checkpoint_1/trial-3`: pass (Core 4/4), checkpoint_2 `cfgpipe/checkpoint_2/trial-1`: pass (Core 3/3), checkpoint_2 `cfgpipe/checkpoint_2/trial-2`: pass (Core 3/3), checkpoint_2 `cfgpipe/checkpoint_2/trial-3`: pass (Core 3/3), checkpoint_3 `cfgpipe/checkpoint_3/trial-1`: pass (Core 4/4), checkpoint_3 `cfgpipe/checkpoint_3/trial-2`: pass (Core 4/4), checkpoint_3 `cfgpipe/checkpoint_3/trial-3`: pass (Core 4/4), checkpoint_4 `cfgpipe/checkpoint_4/trial-1`: fail (Core 6/7), checkpoint_4 `cfgpipe/checkpoint_4/trial-2`: fail (Core 6/7), checkpoint_4 `cfgpipe/checkpoint_4/trial-3`: fail (Core 6/7)

## Regression-group trajectory (native SCBench evaluation)

- cfgpipe: checkpoint_1 `cfgpipe/checkpoint_1/trial-1`: Regression none, checkpoint_1 `cfgpipe/checkpoint_1/trial-2`: Regression none, checkpoint_1 `cfgpipe/checkpoint_1/trial-3`: Regression none, checkpoint_2 `cfgpipe/checkpoint_2/trial-1`: Regression 33/37, checkpoint_2 `cfgpipe/checkpoint_2/trial-2`: Regression 33/37, checkpoint_2 `cfgpipe/checkpoint_2/trial-3`: Regression 33/37, checkpoint_3 `cfgpipe/checkpoint_3/trial-1`: Regression 59/68, checkpoint_3 `cfgpipe/checkpoint_3/trial-2`: Regression 60/68, checkpoint_3 `cfgpipe/checkpoint_3/trial-3`: Regression 59/68, checkpoint_4 `cfgpipe/checkpoint_4/trial-1`: Regression 92/107, checkpoint_4 `cfgpipe/checkpoint_4/trial-2`: Regression 94/107, checkpoint_4 `cfgpipe/checkpoint_4/trial-3`: Regression 92/107

## Factory run outcomes (harness health)

12/12 (100.0%) of Factory runs ended `ready`. This is harness health — a `ready` manifest means the PLAN → BUILD → CHECK pipeline completed, not that SCBench's checkpoint evaluation passed; benchmark correctness above is derived only from native SCBench evidence.

## Elapsed time

Total elapsed: 4156834ms across 12 trial(s); mean 346402.8ms.

## Cost

Total cost: $27.4550; input tokens: 16936768; output tokens: 371878.

## Routing and failover

- claude-fable-5 / plan: 12 attempt(s)
- claude-sonnet-5 / build_claude: 12 attempt(s)

## Provider policy

Declared policy (source: packages/config/src/defaults.ts (typed model registry and routes) at factory.commit): approved models `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`; disabled providers: `ollama`

Run configuration: providers.ollama: false — every benchmark workspace is prepared with .factory/config.json disabling the ollama provider, so local models are stripped from routing before any attempt.

- `cfgpipe/checkpoint_1/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_1/trial-2`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_1/trial-3`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_2/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_2/trial-2`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_2/trial-3`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_3/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_3/trial-2`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_3/trial-3`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_4/trial-1`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_4/trial-2`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved
- `cfgpipe/checkpoint_4/trial-3`: observed models `claude-fable-5`, `claude-sonnet-5` — all approved

Ollama disabled: confirmed — every trial recorded at least one model attempt and every observed model is in the approved set; no disabled-provider model was observed.

## GitHub isolation

Workspace runs use `factory run-brief --workspace`, which disables publishing — SHIP never runs and no GitHub issue, pull request, or merge is created by the run path. Evidence below is derived only from each trial's retained manifest and events.ndjson.

- `cfgpipe/checkpoint_1/trial-1`: run window 2026-09-01T19:44:15.073Z → 2026-09-01T19:48:23.476Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_1/trial-2`: run window 2026-09-02T00:53:38.756Z → 2026-09-02T00:57:31.619Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_1/trial-3`: run window 2026-09-02T01:26:57.092Z → 2026-09-02T01:30:02.260Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_2/trial-1`: run window 2026-09-01T19:48:29.232Z → 2026-09-01T19:52:06.620Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_2/trial-2`: run window 2026-09-02T00:57:36.569Z → 2026-09-02T01:01:47.589Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_2/trial-3`: run window 2026-09-02T01:30:05.102Z → 2026-09-02T01:33:29.647Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_3/trial-1`: run window 2026-09-01T19:52:25.065Z → 2026-09-01T19:56:40.984Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_3/trial-2`: run window 2026-09-02T01:02:07.345Z → 2026-09-02T01:07:09.421Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_3/trial-3`: run window 2026-09-02T01:33:47.603Z → 2026-09-02T01:37:44.226Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_4/trial-1`: run window 2026-09-01T19:57:01.577Z → 2026-09-01T20:07:21.087Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_4/trial-2`: run window 2026-09-02T01:07:31.589Z → 2026-09-02T01:19:16.170Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events
- `cfgpipe/checkpoint_4/trial-3`: run window 2026-09-02T01:38:04.870Z → 2026-09-02T01:49:43.608Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events

GitHub isolation: confirmed — every trial ran under the local-only profile with SHIP skipped, recorded local-only-complete, and no GitHub-write event (issue, PR, or merge) appears in any retained events.ndjson.

## Checker outcomes

- `cfgpipe/checkpoint_1/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_1/trial-2`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_1/trial-3`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_2/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_2/trial-2`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_2/trial-3`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_3/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_3/trial-2`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_3/trial-3`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_4/trial-1`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_4/trial-2`: 4 passed, 0 failed, 3 skipped (total 7).
- `cfgpipe/checkpoint_4/trial-3`: 4 passed, 0 failed, 3 skipped (total 7).

## Failure notes

No failures recorded.

## Reproduction

See `evals/scbench-baseline/README.md` for the exact commands to reproduce the live smoke and small-suite runs and to regenerate this report. Every number above is derived from the trial manifests listed in the Trials section — none is hand-transcribed.
