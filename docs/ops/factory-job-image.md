# The factory job image

`ghcr.io/on-par/factory-job:<version>` is a pinned, non-root, multi-arch (linux/amd64, linux/arm64) image for running **one issue in a disposable container**, for example a Foreman job on Cloudflare Containers. Hosts need no Dockerfile or wrapper script of their own. The publish workflow pushes it on every release tag after the npm packages are out; `:latest` moves only for stable (non-prerelease) tags.

## What is in the image

- Node 24 (bookworm-slim), `git`, `gh` (pinned), `tini` as PID 1
- Claude Code, pinned to the version in `scripts/factory-run.sh`
- `@on-par/factory-cli` at exactly the image tag's version
- The default user is `node` (non-root: Claude Code refuses skip-permissions as root). No token is baked into any layer; secrets arrive as run-time env.

## Run it

```sh
docker run --rm -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN \
  ghcr.io/on-par/factory-job:<version> \
  factory job --repo <owner>/<name> --issue <n> [--merge|--no-pr]
```

`factory job` bootstraps the fresh container (`gh auth setup-git`, Claude Code onboarding state, `git clone`, a local git identity if none is set), picks the config, logs which one it chose, runs `factory run-issue <n> --in-place --json [--merge|--no-pr]` in the clone, and prints one JSON status line as its last stdout line. Progress and logs go to stderr.

| Input                                             | Meaning                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GH_TOKEN` (required)                             | Forge token for clone, push, PR and merge                                                              |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`  | Agent credential, one required                                                                         |
| `--workdir <dir>`                                 | Where to clone (default `~/work`); an existing non-empty `<dir>/<name>` is refused, never deleted      |
| `--factory-dir <dir>` / `FACTORY_JOB_FACTORY_DIR` | A mounted `.factory` directory holding a config file and/or `constitution.md`; empty is a setup error  |
| `--merge`                                         | Land the PR after CI (`run-issue --merge`); `--no-pr` stops after a clean CHECK; the two are exclusive |

## Config order (first match wins)

| #   | Source                                       | Log label                       |
| --- | -------------------------------------------- | ------------------------------- |
| 1   | `--config` / `FACTORY_CONFIG_PATH`           | `--config (<path>)`             |
| 2   | Config file in the mounted `--factory-dir`   | `mounted .factory dir (<path>)` |
| 3   | `FACTORY_CONFIG_YAML`                        | `FACTORY_CONFIG_YAML`           |
| 4   | The clone's committed `.factory/config.yaml` | `repo .factory/config.yaml`     |
| 5   | Container defaults                           | `container defaults`            |

`FACTORY_CONFIG_OVERRIDES` merges over whichever wins (the label gains `; overrides: FACTORY_CONFIG_OVERRIDES`; the child's own `config_source` line lists the redacted key paths). The constitution follows the same pattern: `--constitution` / `FACTORY_CONSTITUTION_PATH`, the mounted `constitution.md`, `FACTORY_CONSTITUTION`, the clone's `.factory/constitution.md`, then the repo instruction files or the bundled default.

**Container defaults** are `version: 2`, `sandbox.runtime: none` (the container is the sandbox) and `disk.minFreeGb: 2`. The packaged 10 GB disk floor would hold a run on a 16 GB container before it starts. A repo config or an override replaces them.

## Status line

One JSON object (`schemaVersion` 1, `kind: "factory-job"`; schema in [cli-json-schemas.md](../cli-json-schemas.md)): `repo`, `issue`, `outcome` (the run's outcome, `failed` when there is none), `merged`, `exitReason`, `exitCode`, `pr` (`{number, url}` or null), `configSource`, `constitutionSource`, and `timings` (`startedAt`, `finishedAt`, `cloneMs`, `runMs`, `totalMs`). Token values never appear in it.

## Exit codes

The job exits with the code `factory run-issue` returns: `0` on success, `1` for a parked or failed run, and the run-issue outcome codes in the `10`–`16` range (see `factory run-issue --help`) for the other outcomes. `2` is a setup error (bad flags, missing secret, clone failure, non-empty clone dir). A signal-killed run exits `1`; a run that exits 0 without a valid result line exits `2`.

## Verify an image by hand

```sh
docker build --build-arg FACTORY_VERSION=<released version> -t factory-job docker/factory-job
docker run --rm factory-job sh -c 'id -u && factory --version && git --version && gh --version && claude --version'
```

Then run `factory job --repo <owner>/<name> --issue <n> --merge` with `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `FACTORY_CONFIG_YAML` set and check for a squash-merged PR, exit 0 and the final status line.
