# SlopCodeBench baseline

This directory pins a reproducible SlopCodeBench (SCBench) baseline for the
Software Factory harness driven through `@on-par/scbench-adapter`
(`../../packages/scbench-adapter/`).

- [`baseline.config.json`](./baseline.config.json) — every pinned input: the
  Factory revision, the SCBench revision (must match
  [`packages/scbench-adapter/scbench.pin.json`](../../packages/scbench-adapter/scbench.pin.json)),
  the problem catalog revision (`problemCatalog` — the separate
  `gabeorlanski/scb-problems` repo the pinned SCBench commit loads problem
  definitions from; must also match `scbench.pin.json`'s `problems` block),
  the model-config posture, environment assumptions, the exact resolved
  problem ids (not a selection rule — see "Problem catalog" below), trial
  counts, the comparison threshold (10 trials per configuration) below which
  a report is labeled below comparison threshold, and the pinned `passPolicy`
  (see "Pass policy" below).
- [`runs/`](./runs) — committed trial artifact sets, one directory per trial,
  each containing `brief.md`, `manifest.json`, `request.json`,
  `events.ndjson`, and `diff.patch`. A trial directory additionally retains,
  verbatim from the SCBench run output, the native evidence files
  `evaluation.json` (from the SCBench checkpoint output directory),
  `checkpoint_results.jsonl` (from the SCBench run root), and `run_info.yaml`
  (resolved run spec + execution summary) whenever a live run has produced
  them. **Benchmark pass rate and erosion in `report.md` derive only from
  these native evidence files** — trials without them count as
  missing-evidence, never as benchmark passes.
- [`report.md`](./report.md) — generated from `baseline.config.json` +
  `runs/` by the `baseline-report` CLI subcommand below. **Never hand-edit
  it** — regenerate it after new trials land.

## Problem catalog

The pinned SCBench harness commit does not itself contain the benchmark
problems — its `problem_catalog.py` loads them from a separate repository,
[`gabeorlanski/scb-problems`](https://github.com/gabeorlanski/scb-problems),
auto-downloading the mutable *latest* GitHub release into `~/.cache/scbench`
unless overridden. `baseline.config.json`'s `problemCatalog` block pins that
catalog's repo, release (`v1.0`), and full commit SHA — identical to
`scbench.pin.json`'s `problems` block — and `problems.smoke`/`problems.suite`
record the exact resolved problem ids (`cfgpipe`; `cfgpipe`, `circuit_eval`,
`code_search`), never a selection rule to be re-evaluated at run time. Every
baseline invocation must export `SCBENCH_PROBLEMS_PATH` to a checkout of the
catalog at the pinned commit; no step reads the auto-synced
`~/.cache/scbench` cache. The launcher (`python/run_scbench.py`) refuses a
`run` invocation whose catalog checkout is missing, at the wrong commit,
dirty (uncommitted changes), or not a git checkout at all.

## Pass policy

`baseline.config.json`'s `passPolicy` pins the exact benchmark-correctness
rule: `core-cases`, mirroring upstream SCBench's `PassPolicy.CORE_CASES` at
the pinned commit — a checkpoint passes iff every Core-group test in its
native `evaluation.json` passes (`pass_counts.Core === total_counts.Core`).
A trial with `infrastructure_failure: true` or with no retained
`evaluation.json` is never counted as a pass, regardless of Factory's own
`manifest.run.outcome`.

## Status

The deterministic stub trials formerly committed under `runs/smoke/trial-1/`
and `runs/smoke/trial-2/` (produced by running the adapter's `runCheckpoint`
twice against a **stub** `factory` binary, with no models involved) have been
removed from the baseline tree. The adapter → manifest → report wiring proof
they provided still lives in
`packages/scbench-adapter/src/run-checkpoint.test.ts` and the collect-trial
fixtures (`packages/scbench-adapter/src/__fixtures__/collect-trial/`), so
`runs/` now contains only live, model-backed trials.

The first **live**, model-backed smoke run is committed (#1064): one
`cfgpipe` run through the pinned SCBench harness and problem catalog,
committed as `runs/cfgpipe/checkpoint_{1,2,3,4}/trial-1/` — 3 of the 4
checkpoints pass under `core-cases` (checkpoint_4 fails one Core case; both
outcomes are legitimate recorded evidence, not a run failure), giving
`report.md` a measured pass rate of 3/4 (75.0%) derived entirely from native
`evaluation.json` evidence. The second required smoke run
(`trials.smokeRuns: 2`) and the live small-suite run (the first three
SCBench problems, `trials.suiteTrialsPerProblem` trials each) remain **not**
executed — deferred to a follow-up story (#1066/#1022), using the exact
commands below. Because 4 of the 10-trial comparison threshold are recorded,
`report.md` is labeled below comparison threshold (not comparison-ready).

Two operational notes from that run, for future reproductions:

- Upstream SCBench's `run_agent.py` resolves a provider credential purely
  for its own bookkeeping before handing off to the `software_factory` agent
  (which ignores it entirely — Factory routes its own models per
  `packages/config`). At the pinned commit this requires a *populated*
  provider env var, not just `model.provider`/`model.name` in
  `scbench.run.yaml`. Do **not** export a real `ANTHROPIC_API_KEY` for this —
  the `claude` CLI treats that env var as an auth override and would stop
  using its logged-in OAuth session. Instead pass
  `--provider-api-key-env <harmless-placeholder-var-name>` (a `run_scbench.py
  run` flag) with that placeholder var set to any non-empty string; the
  credential module only checks presence, never validates or forwards the
  value.
- At the pinned commit, `run_info.yaml` (the per-checkpoint native evidence
  file) records the resolved run spec (model, pass policy, prompt template,
  per-checkpoint status) but does **not** itself record the problem-catalog
  checkout path or commit — that lives in a separate `problem_catalog.json`
  at the run root, which is outside the 8 files `collectTrial` retains and
  which the issue's out-of-scope forbids extending the adapter to also copy.
  The pinned-catalog contract is still enforced and auditable: `npm run
  scbench`'s catalog-preflight and `compat_check.py` both refuse a
  missing/wrong-commit/dirty `SCBENCH_PROBLEMS_PATH` before any run, and this
  run's catalog checkout was verified at `scb-problems@4d38d30` before
  launch.

## Reproducing the live smoke run (twice)

```bash
# 1. Clone SCBench at the pinned commit and export the checkout path — later
#    steps (uv sync, npm run scbench, the launcher) all read SCBENCH_CHECKOUT.
git clone https://github.com/SprocketLab/slop-code-bench.git
cd slop-code-bench
git checkout "$(node -p "require('../software-factory/packages/scbench-adapter/scbench.pin.json').commit")"
export SCBENCH_CHECKOUT="$PWD"

# 1b. Clone the problem catalog at its pinned commit and export it —
#     SCBench otherwise auto-installs the mutable latest release into
#     ~/.cache/scbench, which is forbidden for baseline runs.
cd ..
git clone https://github.com/gabeorlanski/scb-problems.git
cd scb-problems
git checkout "$(node -p "require('../software-factory/packages/scbench-adapter/scbench.pin.json').problems.commit")"
export SCBENCH_PROBLEMS_PATH="$PWD"
cd ..

# 2. Build the adapter from the Software Factory repo root.
cd software-factory
npm ci
npm run build --workspace @on-par/scbench-adapter

# 3. Sync the pinned checkout's Python environment and run the preflight
#    compatibility check (see packages/scbench-adapter/README.md's
#    "Pinned-upstream compatibility check" section) before spending any
#    model budget. This also validates SCBENCH_PROBLEMS_PATH and the
#    resolved problem ids against the catalog checkout.
(cd "$SCBENCH_CHECKOUT" && uv sync)
uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/compat_check.py

# 3b. Run the root-level launch gate from the Software Factory repo root —
#     it re-validates the pinned checkout/catalog commits and the adapter
#     build + problem catalog, and only when both pass prints the exact
#     pinned launcher command(s) below. It never invokes SCBench and never
#     spends model budget; only proceed to step 4 once it exits 0.
npm run scbench

# 4. Run the smoke problem (baseline.config.json's `problems.smoke`, the
#    literal id `cfgpipe`) twice through the committed launcher, which
#    registers the software_factory agent by import before handing off to
#    SCBench's own `slop-code` CLI — use a fresh workspace/artifacts root
#    per trial. SCBENCH_PROBLEMS_PATH (exported in step 1b) must remain set;
#    the launcher itself refuses `run` invocations whose SCBENCH_PROBLEMS_PATH
#    is missing, at the wrong commit, dirty, or not a git checkout — the
#    compat_check.py preflight in step 3 is defense in depth, not the only gate.
uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/run_scbench.py \
  run --config packages/scbench-adapter/scbench.run.yaml --problem cfgpipe

# 5. Collect each trial into the baseline: copies the five Factory artifacts
#    AND the trial's native SCBench evidence — evaluation.json (checkpoint
#    output directory), checkpoint_results.jsonl (run root), run_info.yaml
#    (resolved run spec) — into
#    evals/scbench-baseline/runs/<problem>/<checkpoint>/trial-<n>/. It
#    validates all three native evidence files exist BEFORE writing anything
#    and exits non-zero (trial = missing-evidence, nothing written) when any
#    is absent — a trial without native evidence can never look passing.
node packages/scbench-adapter/dist/cli.js collect-trial \
  --output <factory-artifacts-root> --scbench-run <scbench-run-output-dir> \
  --problem cfgpipe --checkpoint <checkpoint-id> --trial <n>
```

Required tools: `git`, `uv` (Python ≥ 3.12 environment per upstream's
`pyproject.toml`), Node.js ≥ 20, the `claude` CLI, and a `factory` binary on
`PATH` (or `FACTORY_BIN`/`agent.factory_bin` in `scbench.run.yaml`).

## Reproducing the live small suite

Run the three problems named by `baseline.config.json`'s `problems.suite` —
the literal ids `cfgpipe`, `circuit_eval`, and `code_search` — through
SCBench with `trials.suiteTrialsPerProblem` trials per problem, collecting
artifacts the same way, under
`evals/scbench-baseline/runs/<problem>/<checkpoint>/<trial-n>/`. As with the
smoke run, `SCBENCH_PROBLEMS_PATH` must be exported to the pinned catalog
checkout for every invocation.

No step in this baseline reads `~/.cache/scbench`; the baseline never
depends on an untracked catalog cache or upstream "latest" defaults.

## Regenerating the report

```bash
node packages/scbench-adapter/dist/cli.js baseline-report \
  --config evals/scbench-baseline/baseline.config.json \
  --runs evals/scbench-baseline/runs \
  --out evals/scbench-baseline/report.md
```

This must be run (and the result committed) after any new trial artifacts
land under `runs/` — `report.md` is derived output, not hand-authored, and
`packages/scbench-adapter/src/baseline.test.ts` asserts the committed file
is byte-identical to a fresh regeneration.

## Artifact location contract

Everything for this baseline — the pinned config, every trial's artifacts,
and the generated report — lives under `evals/scbench-baseline/`. Nothing
outside this directory is part of the baseline.
