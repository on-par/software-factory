# ADR-0081: Factory-authored SCBench tests live in a git-excluded factory directory, not the visible workspace root

- Status: Accepted
- Date: 2026-09-03

## Context

SCBench workspaces are per-issue git worktrees that SlopCodeBench's own
harness snapshots and scores; a factory build agent working inside one
may write tests to verify its own changes, and until now no ADR said
where those tests should live, so each worker made an ad hoc choice.
That choice constrains multiple future issues (any workspace-test
tooling, any future exclude-list or detection change), so it needs a
durable, cited decision rather than another ad hoc pick.

Issue #1234 answered the three open questions against a read-only
clone of `SprocketLab/slop-code-bench` pinned to the exact commit
recorded in `packages/scbench-adapter/scbench.pin.json`,
`13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7` (the same pin
`evals/scbench-baseline/baseline.config.json` and ADR-0007/ADR-0008
already cite), and is retained as
`docs/research/scbench-harness-snapshot-metrics-evidence.md`:

1. **Snapshot mechanism.** `Snapshot.from_directory`
   (src/slop_code/execution/snapshot.py, lines 258-320,
   https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/execution/snapshot.py#L258-L320)
   builds the workspace snapshot as a plain filesystem `tarfile` archive
   of whatever exists under `cwd` — no git plumbing is involved. Its
   default `ignore_globs` (lines 295-300) is `{"*.pyc", "venv/*",
".venv/*", "**/.DS_Store"}`, which excludes neither test nor
   conftest files nor any dotfile directory such as `.factory/`.

2. **loc/verbosity/erosion metrics.** `measure_snapshot_quality`
   (src/slop_code/metrics/driver.py, lines 523-592,
   https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/driver.py#L523-L592)
   walks the entire snapshot directory via `measure_files`, excluding
   only `__pycache__`, `*.pyc`, `venv`, `.venv`, `virtualenv`,
   `.virtualenv`, `.git`, `node_modules`, `.tox`, `.nox` (lines
   539-550) — never test/conftest files, and not `.factory/` either.
   Every surviving file's line count feeds `total_loc`, which in turn
   feeds `compute_checkpoint_verbosity` and `compute_checkpoint_erosion`
   (src/slop_code/metrics/checkpoint/composites.py, lines 8-28 and
   31-41,
   https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/checkpoint/composites.py#L8-L41).
   A factory-authored test or conftest file left anywhere under the
   snapshot root is therefore counted into those checkpoint quality
   scores exactly like any other source file — confirmed, not
   hypothetical.

3. **Hidden-test collection.** `_build_collect_cmd`
   (src/slop_code/evaluation/collection.py, lines 160-187,
   https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/evaluation/collection.py#L160-L187)
   scopes pytest collection to `WORKSPACE_TEST_DIR`
   (`.evaluation_tests`, src/slop_code/common/constants.py line 16)
   only, with an explicit `--confcutdir=.evaluation_tests` guard the
   code's own comment says exists to keep an agent-authored root-level
   `conftest.py` from affecting collection. A factory-authored test
   file is therefore never visited by this collection step regardless
   of where it lives.

Applying finding (2) rules out the visible workspace-root `tests/`
default this issue's decision rule allows: that default is only
permitted when metrics demonstrably exclude it, and here they do not —
it is a real, confirmed pollution risk. Separately, this repository's
own `packages/scbench-adapter/src/workspace.ts` already establishes
`.factory/` as a git-excluded, factory-owned workspace-state
directory: `prepareWorkspace` creates `.factory/`, `.factory/logs`,
and `.factory/plans`, and `GIT_EXCLUDE_ENTRIES` (line 46) excludes
`.factory/` via `.git/info/exclude` specifically so that "Factory
state plus transient benchmark/runtime artifacts ... never reach
checkpoint commits or diffs" (`commitCheckpoint`, which runs `git add
-A` on every checkpoint, would otherwise commit any tracked file
straight into SCBench's own checkpoint history).

## Decision

Factory-authored tests for a SCBench workspace live under
`.factory/tests/`, and nowhere else — not the visible workspace-root
`tests/` directory, and not any other new location.

`.factory/tests/` is a sibling of the `.factory/logs` and
`.factory/plans` directories `prepareWorkspace` already creates, and it
is already covered by the existing `.factory/` entry in
`GIT_EXCLUDE_ENTRIES` — adopting this location requires no change to
`GIT_EXCLUDE_ENTRIES`, no new detection helper, and no constitution
rewrite beyond stating the location once. This decision does not, by
itself, close the metrics-walk pollution risk in finding (2) above:
`measure_snapshot_quality`'s filesystem walk does not consult git
excludes, so a file under `.factory/tests/` is counted into
`total_loc` (and therefore into the verbosity/erosion composites)
exactly as a visible `tests/` file would be. `.factory/tests/` is
chosen anyway because it is strictly better than the visible
workspace-root default on the dimension this repository's own tooling
controls — it keeps factory-authored tests out of every
`commitCheckpoint` commit and out of the workspace diff that
`workerOutputChecker`/`designSmellsChecker` grade (ADR-0079/ADR-0080)
— while adding zero new git-exclude surface. Actually wiring build
agents to write tests to this path, and closing the residual
metrics-walk exposure identified in finding (2), are implementation
and follow-up-decision work respectively, and are out of scope for
this ADR.

## Consequences

Positive: every future SCBench-workspace worker has one unambiguous,
cited answer for where to put its tests, removing the ad hoc
per-worker choice this issue was filed to close; `.factory/tests/`
reuses an existing git-excluded convention, so adopting it needs no
change to `GIT_EXCLUDE_ENTRIES`, `prepareWorkspace`'s detection
helpers, or the workspace constitution beyond naming the path; and
factory-authored tests are guaranteed to stay out of every checkpoint
commit and out of the diff base that CHECK's workspace checkers grade.

Negative: this decision does not close the metrics-walk pollution risk
confirmed in finding (2) — `.factory/tests/` files are still walked
into SCBench's own `total_loc`/verbosity/erosion scores by the
upstream harness's filesystem-based `measure_snapshot_quality`, so a
factory-authored test still inflates those checkpoint quality metrics
today. Closing that gap (e.g. teaching the harness invocation to pass
its own broader `ignore_globs`, or stripping `.factory/` before a
metrics-scoring snapshot is taken) is a deliberate follow-up decision,
not resolved here. Any future change to `prepareWorkspace` must also
create `.factory/tests/` alongside `.factory/logs`/`.factory/plans`
for this decision to take effect operationally — that wiring is
separate implementation work this ADR does not perform.

## References

- [Issue #1235: Author an Accepted ADR deciding factory-authored test location for SCBench workspaces](https://github.com/on-par/software-factory/issues/1235)
- [Issue #1234 discovery: SCBench harness snapshot and metrics evidence](https://github.com/on-par/software-factory/issues/1234)
- [Retained discovery doc: docs/research/scbench-harness-snapshot-metrics-evidence.md](../research/scbench-harness-snapshot-metrics-evidence.md)
- [SCBench Snapshot.from_directory at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/execution/snapshot.py#L258-L320)
- [SCBench measure_snapshot_quality at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/driver.py#L523-L592)
- [SCBench compute_checkpoint_verbosity / compute_checkpoint_erosion at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/checkpoint/composites.py#L8-L41)
- [SCBench hidden-test collection scoping (_build_collect_cmd) at the pinned commit](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/evaluation/collection.py#L160-L187)
- [packages/scbench-adapter/src/workspace.ts (GIT_EXCLUDE_ENTRIES, prepareWorkspace)](../../packages/scbench-adapter/src/workspace.ts)
- [ADR-0080: The workspace diff base is the run-start HEAD, captured once, authoritative for CHECK](0080-the-workspace-diff-base-is-the-run-start-head-captured-once-authoritative-for-check.md)
