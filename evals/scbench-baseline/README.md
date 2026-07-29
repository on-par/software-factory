# SlopCodeBench baseline

This directory pins a reproducible SlopCodeBench (SCBench) baseline for the
Software Factory harness driven through `@on-par/scbench-adapter`
(`../../packages/scbench-adapter/`).

- [`baseline.config.json`](./baseline.config.json) — every pinned input: the
  Factory revision, the SCBench revision (must match
  [`packages/scbench-adapter/scbench.pin.json`](../../packages/scbench-adapter/scbench.pin.json)),
  the model-config posture, environment assumptions, a deterministic
  problem-set selection rule, trial counts, and the comparison threshold
  (10 trials per configuration) below which a report is labeled preliminary.
- [`runs/`](./runs) — committed trial artifact sets, one directory per trial,
  each containing `brief.md`, `manifest.json`, `request.json`,
  `events.ndjson`, and `diff.patch`.
- [`report.md`](./report.md) — generated from `baseline.config.json` +
  `runs/` by the `baseline-report` CLI subcommand below. **Never hand-edit
  it** — regenerate it after new trials land.

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

# 2. Build the adapter from the Software Factory repo root.
cd ../software-factory
npm ci
npm run build --workspace @on-par/scbench-adapter

# 3. Register the custom agent per SCBench's docs (see
#    packages/scbench-adapter/README.md's Setup section), pointing
#    adapter_cli at packages/scbench-adapter/dist/cli.js.

# 4. Run the smoke problem (baseline.config.json's `problems.smoke`) twice,
#    collecting artifacts under evals/scbench-baseline/runs/<problem>/<checkpoint>/<trial-n>/
#    for each run — repeat with a fresh workspace/artifacts root per trial.
```

## Reproducing the live small suite

Run the three problems named by `baseline.config.json`'s `problems.suite`
through SCBench with `trials.suiteTrialsPerProblem` trials per problem,
collecting artifacts the same way, under
`evals/scbench-baseline/runs/<problem>/<checkpoint>/<trial-n>/`.

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
