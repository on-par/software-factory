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

2. Build the adapter from the Software Factory repo root:

   ```bash
   npm ci
   npm run build --workspace @on-par/scbench-adapter
   ```

3. Register the custom agent per SCBench's
   [custom-agent docs](https://github.com/SprocketLab/slop-code-bench/blob/main/docs/agents/agent-class.md):
   copy or symlink [`python/software_factory.py`](./python/software_factory.py)
   into SCBench's agents directory, then reference it in your run config:

   ```yaml
   agent:
     type: software_factory
     adapter_cli: /absolute/path/to/software-factory/packages/scbench-adapter/dist/cli.js
     # factory_bin: /absolute/path/to/factory   # optional; defaults to `factory` on PATH
   ```

## Prerequisites

- The `claude` CLI on `PATH` (required by `factory run-brief`).
- Node.js ≥ 20, with the adapter built (`dist/cli.js` present).
- Model policy is the evaluator's choice — the adapter never forces one. Set
  `FACTORY_LOCAL_ONLY=1` in the SCBench process environment for an
  all-local model policy, or leave routing as configured in
  `packages/config/src/routes.json`.

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

## Isolation guarantees

- No GitHub issue, queue file, pull request, merge, or production checkout
  is ever touched — the adapter only calls `factory run-brief --workspace`.
- Factory's own state (`.factory/`) lives inside the SCBench-provided
  workspace and is git-excluded (`.git/info/exclude`), so it never appears
  in SCBench's diffs or evaluation.
- The checkpoint brief is written under SCBench's artifacts root, never
  inside the workspace, for the same reason.
