# SCBench harness snapshot and metrics evidence for factory-authored tests (Issue #1234)

Date: 2026-09-03

## Purpose and scope

This is the #1234 discovery artifact. It answers, with pinned-commit citations
into the upstream SCBench harness source, three questions about
factory-authored test/conftest files that land in the visible SlopCodeBench
submission workspace root:

1. Is the harness's workspace snapshot git-based or filesystem-based, and does
   its default exclusion set filter out `test_*.py` / `conftest.py`?
2. Which code computes the `loc`/`verbosity`/`erosion` checkpoint quality
   metrics, and does that computation exclude workspace-root test/conftest
   files?
3. Is a workspace-root `test_*.py` or `conftest.py` file picked up by the
   harness's hidden-checkpoint-test collection (`pytest_collected` /
   `test_collection_hash`)?

This is a **read-only discovery document**: no code, pin, or ADR change is
made or proposed here. Every claim is cited by `file:line` against a fresh,
read-only clone of `SprocketLab/slop-code-bench` checked out to the pin
committed in `packages/scbench-adapter/scbench.pin.json`,
`13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7`, plus a GitHub blob URL pinned to
that same commit SHA. This document names only the harness's own
general-purpose code paths — it does not identify any specific checkpoint
fixture or reveal what any individual coding problem checks for.

## Bottom line

- **(a) Snapshot mechanism**: the harness snapshots the workspace via a
  **filesystem tarfile archive**, not git. Its default ignore list is narrow
  (`*.pyc`, `venv/*`, `.venv/*`, `**/.DS_Store`) and does **not** exclude
  `test_*.py` or `conftest.py`.
- **(b) Metrics computation**: `loc`/`verbosity`/`erosion` are computed by
  walking the **entire snapshot directory**, excluding only
  `__pycache__`/`*.pyc`/`venv`/`.venv`/`virtualenv`/`.virtualenv`/`.git`/
  `node_modules`/`.tox`/`.nox` — never test or conftest files. **This is a
  real, confirmed pollution risk**: a factory-authored test/conftest file left
  at the workspace root is counted toward the quality metrics.
- **(c) Hidden-test collection**: is scoped to `.evaluation_tests/` only, with
  an explicit `--confcutdir=.evaluation_tests` guard that the harness's own
  source comments say exists specifically to keep an agent-authored
  `conftest.py` at the workspace root from affecting collection. **This risk
  is already mitigated upstream**: a workspace-root `test_*.py` or
  `conftest.py` file is **not** picked up by `pytest_collected` /
  `test_collection_hash`.

In short: metrics pollution from a stray workspace-root test/conftest file is
real; hidden-checkpoint-test-collection pollution is not — the harness already
guards against the latter but not the former.

## (a) Snapshot mechanism is filesystem, not git

`src/slop_code/execution/snapshot.py` defines `class Snapshot` (line 226) with
a `from_directory` classmethod (lines 258-320,
[blob](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/execution/snapshot.py#L258-L320)).
`from_directory` walks the candidate paths under `cwd` and writes matched
paths into a compressed `tarfile` archive:

```python
# snapshot.py:313-320
with tarfile.open(str(archive_path), mode=tar_mode) as tf:  # type: ignore
    for rel_path in matched_paths:
        abs_path = cwd / rel_path
        tf.add(
            abs_path,
            arcname=rel_path.as_posix(),
            recursive=False,
        )
```

No git plumbing (`git archive`, index, or working-tree diff) is involved — the
snapshot is a plain filesystem tar of whatever files exist under `cwd` at
snapshot time. The default `ignore_globs`, used whenever the caller doesn't
pass its own (lines 295-300), is:

```python
# snapshot.py:295-300
ignore_globs = ignore_globs or {
    "*.pyc",
    "venv/*",
    ".venv/*",
    "**/.DS_Store",
}
```

Nothing in this default set excludes `test_*.py` or `conftest.py`. A
factory-authored test or conftest file sitting at the workspace root is a
plain source file to this snapshot mechanism and is included in the archive
like any other file.

## (b) loc/verbosity/erosion metrics scan the whole snapshot, no test/conftest exclusion

`src/slop_code/metrics/driver.py` defines `measure_snapshot_quality` (line
523,
[blob](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/driver.py#L523-L592)).
It walks every file under the snapshot directory via `measure_files`, using
its own `exclude_patterns` (lines 539-550):

```python
# driver.py:539-550
exclude_patterns = {
    "__pycache__",
    "*.pyc",
    "venv",
    ".venv",
    "virtualenv",
    ".virtualenv",
    ".git",
    "node_modules",
    ".tox",
    ".nox",
}
```

Again, no `test_*.py` or `conftest.py` exclusion. Every file that survives
this filter contributes to the running `total_loc` aggregate:

```python
# driver.py:586
total_loc += file_metric.lines.loc
```

`total_loc` is accumulated into the returned `SnapshotMetrics`, which feeds
the checkpoint-level composite scores in
`src/slop_code/metrics/checkpoint/composites.py`:

- `compute_checkpoint_verbosity` (lines 8-28,
  [blob](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/checkpoint/composites.py#L8-L28))
  derives its score from `metrics["loc"]` together with clone-line and
  violation-percentage ratios pulled from that same snapshot-wide aggregate
  (`clone_ratio = clone_lines / loc` at line 27).
- `compute_checkpoint_erosion` (lines 31-41,
  [blob](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/metrics/checkpoint/composites.py#L31-L41))
  derives its score from `metrics["mass.high_cc_pct"]`, likewise sourced from
  the whole-snapshot scan.

Neither composite, nor the snapshot-wide scan that feeds them, has any
awareness of which files were authored by the harness's own checkpoint fixture
versus by the agent under evaluation. A `test_*.py` or `conftest.py` file left
at the workspace root by a factory build agent is walked, counted into
`total_loc`, and folded into both the verbosity and erosion checkpoint scores
exactly like any other source file.

## (c) Hidden-test collection is scoped away from the workspace root

`src/slop_code/common/constants.py` defines the collection target directory:

```python
# constants.py:16
WORKSPACE_TEST_DIR = ".evaluation_tests"
```

`src/slop_code/evaluation/collection.py`'s `_build_collect_cmd` (lines
160-187,
[blob](https://github.com/SprocketLab/slop-code-bench/blob/13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7/src/slop_code/evaluation/collection.py#L160-L187))
builds the pytest collection invocation with two relevant properties:

```python
# collection.py:168-187
parts = [
    "uvx",
    *_build_with_flags(problem),
    "pytest",
    "--collect-only",
    "-q",
    # Exclude an agent-authored conftest.py at the workspace root from
    # collection (SCBench's own conftest lives inside WORKSPACE_TEST_DIR).
    f"--confcutdir={WORKSPACE_TEST_DIR}",
    f"--entrypoint={shlex.quote(entrypoint)}",
    f"--checkpoint={shlex.quote(checkpoint_name)}",
]

if marker is not None:
    parts.extend(["-m", shlex.quote(marker)])

parts.extend(["-k", shlex.quote(checkpoint_name)])
parts.extend(_quote_args(pytest_args))
parts.append(WORKSPACE_TEST_DIR)
return " ".join(parts)
```

1. The final positional collection target (line 186,
   `parts.append(WORKSPACE_TEST_DIR)`) scopes pytest's collection to
   `.evaluation_tests` only — a `test_*.py` file sitting at the workspace root
   is outside that target directory and is therefore never visited by this
   collect invocation in the first place.
2. The explicit `--confcutdir=.evaluation_tests` flag (line 176) is present
   specifically — per the code's own comment immediately above it (lines
   174-175) — "to exclude an agent-authored `conftest.py` at the workspace
   root from collection," so that a root-level `conftest.py` cannot affect
   pytest's collection/config behavior even indirectly through pytest's normal
   upward `conftest.py` discovery.

The results of this collection populate the hidden-test signals downstream in
the same file:

```python
# collection.py:449-450
results.pytest_collected = collection.total_collected
results.test_collection_hash = collection.test_collection_hash
```

Since the collection invocation never targets or walks through the workspace
root, a `test_*.py` or `conftest.py` file left there does not contribute to
`collection.total_collected` or `collection.test_collection_hash`, and
therefore does not affect `pytest_collected` / `test_collection_hash`.

## Contrast: metrics pollution is real, hidden-test-collection pollution is not

The harness applies two different postures to the same class of
factory-authored workspace-root file:

- The quality-metrics scan (`measure_snapshot_quality` in `driver.py`) walks
  the **entire** snapshot directory with an exclude list that has nothing to
  do with test/conftest files — a workspace-root `test_*.py` or `conftest.py`
  is counted into `loc` and, through it, into the `verbosity` and `erosion`
  checkpoint composites. **This is a real, confirmed pollution risk** left
  unaddressed by this issue (fixing it is explicitly out of scope; see
  Non-goals below).
- The hidden-checkpoint-test collection path (`_build_collect_cmd` in
  `collection.py`) is deliberately scoped to `.evaluation_tests` and
  additionally hardened with `--confcutdir` specifically to keep
  agent-authored root-level files from reaching collection. **This risk is
  already mitigated upstream** — no further action is needed for the
  `pytest_collected` / `test_collection_hash` signals.

## Non-goals

Per the source issue, this document does not: run SCBench or invoke any
model; write or accept an ADR; change any code in
`packages/scbench-adapter` (including `GIT_EXCLUDE_ENTRIES` in
`packages/scbench-adapter/src/workspace.ts`); bump
`packages/scbench-adapter/scbench.pin.json` or
`evals/scbench-baseline/baseline.config.json`; or propose a fix for the
metrics-pollution risk identified in finding (b) — that is a decision for a
follow-up issue.

## Method

A read-only clone of `https://github.com/SprocketLab/slop-code-bench` was
made into a scratch directory outside this repository checkout and checked
out to the pinned commit:

```
$ git checkout 13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7 && git rev-parse HEAD
13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7
```

Every `file:line` citation above was re-verified against that checkout with
`rg -n` immediately before this document was written; the scratch clone was
deleted afterward and is not part of this commit.
