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
  a report is labeled preliminary, and the pinned `passPolicy` (see "Pass
  policy" below).
- [`runs/`](./runs) — committed trial artifact sets, one directory per trial,
  each containing `brief.md`, `manifest.json`, `request.json`,
  `events.ndjson`, and `diff.patch`. A trial directory additionally retains,
  verbatim from the SCBench run output, the native evidence files
  `evaluation.json` (from the SCBench checkpoint output directory),
  `checkpoint_results.jsonl` (from the SCBench run root), and `run_info.yaml`
  (resolved run spec + execution summary) whenever a live run has produced
  them. **Benchmark pass rate and erosion in `report.md` derive only from
  these native evidence files** — trials without them (like the committed
  stub trials below) count as missing-evidence, never as benchmark passes.
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

The evidence committed under `runs/smoke/trial-1/` and `runs/smoke/trial-2/`
comes from running the adapter's `runCheckpoint` twice against a **stub**
`factory` binary (the same pattern as
`packages/scbench-adapter/src/run-checkpoint.test.ts`) — it proves the
adapter → manifest → report wiring end-to-end, deterministically, with no
models involved.

The **live**, model-backed smoke run (SCBench's actual smoke problem, run
twice) and the live small-suite run (the first three SCBench problems,
`trials.suiteTrialsPerProblem` trials each) have **not** been executed here.
This build environment has no network access to clone the pinned SCBench
commit and no model/CLI budget to spend — both are required for a live run.
Those runs are deferred to an operator with network + model access, using the
exact commands below; the stub wiring evidence is preserved as the partial
artifact set in the meantime. Because only 2 trials (both stubs) are
recorded against a comparison threshold of 10, `report.md` is labeled
**PRELIMINARY** throughout.

## Reproducing the live smoke run (twice)

```bash
# 1. Clone SCBench at the pinned commit.
git clone https://github.com/SprocketLab/slop-code-bench.git
cd slop-code-bench
git checkout "$(node -p "require('../software-factory/packages/scbench-adapter/scbench.pin.json').commit")"

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

# 5. Copy each trial's Factory artifacts (manifest.json, request.json,
#    events.ndjson, diff.patch, brief.md) into
#    evals/scbench-baseline/runs/<problem>/<checkpoint>/<trial-n>/, and
#    additionally copy that trial's native SCBench evidence — evaluation.json
#    (from SCBench's checkpoint output directory), checkpoint_results.jsonl
#    (from SCBench's run root), and run_info.yaml (resolved run spec +
#    execution summary) — into the same trial directory, alongside the
#    Factory artifacts. Benchmark pass rate and erosion in report.md are
#    derived only from these native evidence files.
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
