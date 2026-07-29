# @on-par/scbench-adapter

Drives [Software Factory](../../README.md) as the agent under test for
[SlopCodeBench](https://github.com/SprocketLab/slop-code-bench) (SCBench), a
Python framework that runs agents through multi-checkpoint problems.

For every checkpoint, this package:

1. Turns the checkpoint's task string into a valid Factory local Markdown
   brief (`materializeBrief`).
2. Prepares (or reuses) a persistent git workspace for the problem
   (`prepareWorkspace`) — code from earlier checkpoints stays in place.
3. Invokes `factory run-brief <brief> --workspace <ws> --artifacts <dir>`
   (the #507/#508/#509 local-only path: no worktree, publishing disabled,
   SHIP skipped, a versioned benchmark manifest emitted).
4. Validates the resulting `manifest.json` against
   `BENCHMARK_MANIFEST_VERSION` and returns a structured `CheckpointResult`.
5. Commits the workspace so the next checkpoint sees this checkpoint's edits.

It never creates or mutates a GitHub issue, queue file, pull request, merge,
or production checkout — `factory run-brief --workspace` hard-disables
publishing in the CLI.

## Setup

1. Clone SCBench at the pinned commit recorded in [`scbench.pin.json`](./scbench.pin.json):

   ```bash
   git clone https://github.com/SprocketLab/slop-code-bench.git
   cd slop-code-bench
   git checkout "$(node -p "require('../software-factory/packages/scbench-adapter/scbench.pin.json').commit")"
   ```

2. Clone the problem catalog at its pinned commit (`scbench.pin.json`'s `problems` block) and
   export it. The pinned SCBench commit does not contain the benchmark problems — its
   `problem_catalog.py` loads them from the separate
   [`gabeorlanski/scb-problems`](https://github.com/gabeorlanski/scb-problems) repo,
   auto-downloading the mutable _latest_ release into `~/.cache/scbench` unless
   `SCBENCH_PROBLEMS_PATH` is set:

   ```bash
   git clone https://github.com/gabeorlanski/scb-problems.git
   cd scb-problems
   git checkout "$(node -p "require('../software-factory/packages/scbench-adapter/scbench.pin.json').problems.commit")"
   export SCBENCH_PROBLEMS_PATH="$PWD"
   ```

3. Build the adapter from the Software Factory repo root:

   ```bash
   npm ci
   npm run build --workspace @on-par/scbench-adapter
   ```

4. Register the custom agent by running it through the committed launcher.
   At the pinned commit, SCBench has **no custom-agent discovery mechanism**
   (`slop_code/agent_runner/agents/__init__.py` imports a hardcoded list), so
   the previously documented "copy/symlink into SCBench's agents directory"
   step can never work — a dropped-in file is never imported, so its
   `register_agent()` side effect never runs. Instead,
   [`python/run_scbench.py`](./python/run_scbench.py) imports the shim (which
   registers the `software_factory` agent type) and then hands off to
   SCBench's own `slop-code` CLI:

   ```bash
   # From the pinned SCBench checkout's uv environment, invoked from the
   # Software Factory repo root:
   uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/run_scbench.py \
     run --config packages/scbench-adapter/scbench.run.yaml --problem <problem-id>
   ```

   The run config is [`scbench.run.yaml`](./scbench.run.yaml), committed at
   the adapter root. Its `agent.adapter_cli` is intentionally omitted — the
   shim derives `packages/scbench-adapter/dist/cli.js` from its own file
   location, so the run config never needs a machine-specific absolute path.
   `agent.cost_limits` is `0` (unlimited) for every field because Factory
   enforces its own cost/step budgets independently. SCBench also requires a
   `model`/credential block for its own harness bookkeeping even though the
   Factory adapter ignores it (Factory routes its own models per
   `packages/config`) — the committed config sets a placeholder
   `model.provider`/`model.name` to satisfy that requirement.

   Override `node_bin`, `adapter_cli`, or `factory_bin` in a copy of
   `scbench.run.yaml` if your environment needs them (e.g. a non-PATH
   `factory` binary via `factory_bin`, or `FACTORY_BIN`).

   `scbench.run.yaml` also sets `thinking: none` and `pass_policy:
core-cases` explicitly — both are real `RunConfig` fields (upstream
   defaults `thinking` to `none` already, but `pass_policy` defaults to
   `any`) — so the resolved run config carries no implicit inputs and stays
   aligned with `baseline.config.json`'s pinned `passPolicy.id`.

## Prerequisites

- `git`, and `uv` with a Python ≥ 3.12 environment (per upstream's
  `pyproject.toml`) for the pinned SCBench checkout.
- `SCBENCH_PROBLEMS_PATH` set to a checkout of the pinned problem catalog
  (`scbench.pin.json`'s `problems.commit`) — see step 2 above. Required for
  every run; the auto-synced `~/.cache/scbench` catalog is never used.
- The `claude` CLI on `PATH` (required by `factory run-brief`).
- Node.js ≥ 20, with the adapter built (`dist/cli.js` present).
- A `factory` binary on `PATH` (or set via `FACTORY_BIN`/`agent.factory_bin`
  in `scbench.run.yaml`).
- Model policy is the evaluator's choice — the adapter never forces one. Set
  `FACTORY_LOCAL_ONLY=1` in the SCBench process environment for an
  all-local model policy, or leave routing as configured in
  `packages/config/src/routes.json`.

## Pinned-upstream compatibility check

[`python/compat_check.py`](./python/compat_check.py) is a committed,
automated check that proves the shim actually works against the pinned
SCBench checkout — registration, config loading from the committed
`scbench.run.yaml`, agent construction via `_from_config`, `setup()` against
a real `Session`, two `run()` invocations through the real `dist/cli.js`
(with a stub `factory` binary), artifact handoff via `save_artifacts`,
workspace persistence across checkpoints, and that `cleanup()` never deletes
the SCBench workspace. It refuses to run unless the checkout's git HEAD
matches `scbench.pin.json`'s pinned commit (set `SCBENCH_PIN_ALLOW_DRIFT=1`
to downgrade that to a warning during forward-porting work). It also
validates the problem catalog: `SCBENCH_PROBLEMS_PATH` must be set and point
at an existing checkout whose git HEAD matches `scbench.pin.json`'s
`problems.commit` (missing or drifted checkouts are refused the same way,
also downgradable with `SCBENCH_PIN_ALLOW_DRIFT=1`), and every resolved
problem id in `evals/scbench-baseline/baseline.config.json` must have a
`config.yaml` directory in that checkout. Run it inside the pinned
checkout's `uv` environment:

```bash
uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/compat_check.py
```

This requires network (to have cloned the pinned checkout) and a Python
toolchain, so it is intentionally **not** wired into `scripts/verify.sh` or
CI — the same posture as the live-baseline commands below. CI instead runs
`src/python-shim.test.ts`, a static conformance test that catches drift in
the shim's import surface, lifecycle methods, and CLI flags without needing
Python installed.

## Smoke test

With a stub `factory` binary (no models involved — proves wiring only):

```bash
node packages/scbench-adapter/dist/cli.js run-checkpoint \
  --workspace /tmp/scb-ws \
  --artifacts /tmp/scb-art \
  --task-file /tmp/task.md \
  --problem demo \
  --checkpoint 1 \
  --factory-bin /bin/true
```

`/bin/true` exits 0 without writing a manifest, so the CLI prepares the
workspace, writes the brief, and reports the missing-manifest failure as a
structured JSON `CheckpointResult` (`outcome: "error"`) on stdout — this
proves the wiring without needing real models. The full stubbed
two-checkpoint variant (including workspace reuse across checkpoints) is
automated in `src/run-checkpoint.test.ts`.

## Baseline

[`evals/scbench-baseline/`](../../evals/scbench-baseline/) holds the pinned,
reproducible SlopCodeBench baseline for this adapter: a committed
configuration pinning every input (Factory revision, SCBench revision, model
config, environment, problem set, trial counts), preserved trial evidence,
a generated report (`report.md`, labeled PRELIMINARY until 10+ trials per
configuration land), and the exact commands to reproduce or extend it. See
[`evals/scbench-baseline/README.md`](../../evals/scbench-baseline/README.md).

## Isolation guarantees

- No GitHub issue, queue file, pull request, merge, or production checkout
  is ever touched — the adapter only calls `factory run-brief --workspace`.
- Factory's own state (`.factory/`) lives inside the SCBench-provided
  workspace and is git-excluded (`.git/info/exclude`), so it never appears
  in SCBench's diffs or evaluation.
- The checkpoint brief is written under SCBench's artifacts root, never
  inside the workspace, for the same reason.
