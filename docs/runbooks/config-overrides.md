# Per-run config and constitution overrides

A host, for example a disposable container, can control a run's config and constitution without writing into the checkout. The sources form one ladder, highest first:

| Rank | Source                                                                    | What it is                                                 |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `FACTORY_CONFIG_OVERRIDES`                                                | A YAML fragment deep-merged over the winner of ranks 2-5   |
| 2    | `--config <path>`, else `FACTORY_CONFIG_PATH`, else `FACTORY_CONFIG_YAML` | A whole-file override; it replaces the repo file wholesale |
| 3    | `--project-config <dir>`, else `FACTORY_PROJECT_CONFIG_DIR`               | `config.yaml` in a directory outside the checkout          |
| 4    | `.factory/config.yaml` (or `.yml` / `.json`)                              | The repo's file                                            |
| 5    | Packaged defaults                                                         | Used when none of the above exists                         |

In short, the config order is: `--config` / `FACTORY_CONFIG_*`, then the project config directory, then the repo file, then packaged defaults, with `FACTORY_CONFIG_OVERRIDES` merged over the winner.

Constitutions use the same order, highest first:

1. `--constitution <path>`, else `FACTORY_CONSTITUTION_PATH`, else inline `FACTORY_CONSTITUTION`.
2. `constitution.md` in the project config directory (`--project-config <dir>`, else `FACTORY_PROJECT_CONFIG_DIR`).
3. The repo's `.factory/constitution.md`.
4. The repo instruction files, else the bundled constitution.

## Project config directory

`--project-config <dir>` (the flag wins) or `FACTORY_PROJECT_CONFIG_DIR` points a run at a directory outside the checkout. Its `config.yaml` and `constitution.md` replace the repo's `.factory/` files wholesale, with no fallback to them. The external `config.yaml` is always checked with the strict schemas. A missing directory, a missing or empty file, or an invalid config fails before PLAN with an error naming the source and the file.

The directory also supplies the run's other inputs, again with no fallback to the checkout:

| Input                    | Replaces                          |
| ------------------------ | --------------------------------- |
| `agent-memory/<lane>.md` | `.factory/agent-memory/<lane>.md` |
| `product`                | The active product file           |
| `tests/`                 | `.factory/tests/`                 |

Each one is optional. When one is present, it is checked before PLAN, and an invalid file fails the run with an error naming the source and the file, for example `Invalid FACTORY_PROJECT_CONFIG_DIR (/srv/project/agent-memory/core.md): 5000 bytes, over the 4096-byte cap`. These rules apply:

- `agent-memory/` holds only regular `.md` files of UTF-8 text, each at most 4096 bytes. In the checkout, an oversized file is ignored with a warning. In the project config directory, it fails the run.
- `product` is a regular UTF-8 file that holds one product name: letters, digits, `.`, `_` or `-`, not starting with `.` or `_`.
- `tests/` is a directory that holds only regular files and directories. Symlinks are rejected.

`factory constitution --product <name>` writes the product name to `<dir>/product` when the directory is set, and to the checkout's active product file when it is not.

### A checkout with no `.factory/` folder

With the directory set, `factory run-issue`, `factory ship` and `factory run-brief` run in a checkout that has no `.factory/` folder. You do not need `factory init`. For example:

```sh
factory --project-config /srv/project run-issue 42
FACTORY_PROJECT_CONFIG_DIR=/srv/project factory run-issue 42
```

The run still writes its run-time state (events, logs, plans, locks) to `.factory/state/` in the checkout, or to the state root when one is set (see [state-root.md](state-root.md)). Before it writes anything, the run adds `/.factory/state/` to the checkout's local git exclude file (`.git/info/exclude`), unless that file already excludes `/.factory/` or `/.factory/state/`. The exclude file is never committed, so the run adds no tracked file, and `git status --porcelain` shows no path under `.factory/` when the run ends. With no directory set, none of this happens: a checkout without `.factory/` still needs `factory init`.

### Container jobs

`factory job` reads the directory from the same flag or variable. Inside the container, the value must be the path where the host mounted the directory, never a host path. Mount the directory read-only and set the variable to the mount path:

```sh
docker run --rm -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN \
  --mount type=bind,src=/srv/project,dst=/factory/project,readonly \
  -e FACTORY_PROJECT_CONFIG_DIR=/factory/project \
  ghcr.io/on-par/factory-job:<version> \
  factory job --repo <owner>/<name> --issue <n>
```

The job checks the directory before it clones. If the directory does not exist in the container, for example because a host path was passed as-is, the job exits 2 with an error naming the source, for example `factory job: FACTORY_PROJECT_CONFIG_DIR: no such directory: /srv/project`. The job passes the absolute in-container path to the run, so CHECK runs the directory's `tests/` from the mount path. See [factory-job-image.md](../ops/factory-job-image.md) for where the directory ranks among the job's sources.

The per-key environment variables that already exist still apply on top of the resolved config.

## Examples

```sh
# A 16 GB disk: lower the free-space floor for this run only.
FACTORY_CONFIG_OVERRIDES=$'disk:\n  minFreeGb: 2' factory run-issue 42

# A container with no OS sandbox runtime.
FACTORY_CONFIG_OVERRIDES=$'sandbox:\n  runtime: none' factory run-issue 42

# Use a config baked into the image, and pin models on top of it.
factory --config /etc/factory/config.yaml run-issue 42
FACTORY_CONFIG_PATH=/etc/factory/config.yaml FACTORY_CONFIG_OVERRIDES=$'models:\n  plan: claude-opus-5-5' factory run-issue 42

# A small disk: keep at most 3 finished lane worktrees per repo.
FACTORY_CONFIG_OVERRIDES=$'worktree:\n  retainMax: 3' factory run-issue 42
```

`worktree.retainMax` (default 8, `0` = no count budget) bounds how many finished or failed lane worktrees a repo keeps, independently of `host.maxBuilds`. Between issues the run evicts the oldest clean, fully pushed trees beyond the budget, and when the disk guard trips it evicts every eligible tree before it holds BUILD, CHECK or a claim. A tree backing an open PR is evicted too, because land recreates it from `origin/<branch>`. Eviction removes only the worktree directory and never the local branch. Trees held by a live claim or a conflict rebuild, and trees with uncommitted, untracked or unpushed work or an unverifiable remote, are never evicted. Each kept tree is logged as a `worktree-gc` event naming its reason (#3970).

## Validation

Every override is checked with the same strict schemas as the repo file. A bad override fails before PLAN and the error names the source, for example `Invalid FACTORY_CONFIG_OVERRIDES: bogusKey: Unrecognized key`. The fragment is checked on its own first, so an unknown key is blamed on the fragment, then the merged result is checked and blamed on the winning source.

## Reporting and redaction

`run-issue`, `run-brief`, `ship` and `run` print `factory: config: <source>; constitution: <source>` and record a `config_source` event. `factory doctor` shows a `config sources` row and a `sources` object under `--json`. Only key paths that the fragment changed are listed, never values.

When a project config directory is set, the line, the event and the doctor row add `external source: <source> (<dir>)`. If the checkout also has `.factory/` inputs that the directory replaces, they add `ignored checkout inputs:` and the repo-relative paths, sorted. The inputs checked are `.factory/config.yaml` (or `.yml` / `.json`), `.factory/constitution.md`, `.factory/agent-memory` and `.factory/tests`. Files under `.factory/state/` are run-time state, not inputs, so the report never lists them. Only paths are listed, never file contents. For example:

```text
factory: config: --project-config (/srv/project/config.yaml); constitution: --project-config; external source: --project-config (/srv/project); ignored checkout inputs: .factory/config.yaml, .factory/constitution.md
```

The `config_source` event carries the same data in a `projectConfig` field, `{ "source": "--project-config", "dir": "/srv/project", "ignoredInputs": [".factory/config.yaml", ".factory/constitution.md"] }`. `ignoredInputs` is `[]` when the checkout has none of these inputs. `factory doctor --json` puts the same object at `sources.projectConfig`. `factory doctor` checks the lane memory files in the directory's `agent-memory/`, and the CHECK probe names the directory's `tests/` as the pytest source. With no project config directory, none of these fields or segments appear. A key whose last segment ends in `Env`, or contains `token`, `secret`, `password`, `apikey` or `credential`, is shown as `<redacted key>`.

## A daemon snapshot wins

A run started by the daemon already carries an immutable config snapshot (`FACTORY_RUN_CONFIG_JSON`). That snapshot wins over every override above.
