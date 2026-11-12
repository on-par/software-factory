# Factory job image

`ghcr.io/on-par/factory-job:<version>` is a pinned, non-root, multi-arch (linux/amd64, linux/arm64) image for
running one issue in a disposable container, such as Foreman on Cloudflare Containers. No host needs its own
Dockerfile or wrapper script: the entrypoint command is `factory job`.

The publish workflow builds it for every `vX.Y.Z` release tag, after the npm package is visible, and tags it
`<version>`; `latest` moves only for non-prerelease tags. Main prereleases do not publish an image.

## What is in it

- `node:24-bookworm-slim`, running as the `node` user with `tini` as PID 1.
- `git` and `gh` (pinned), Claude Code (pinned to the version in `scripts/factory-run.sh`) and
  `@on-par/factory-cli` at the image's tag version.
- `FACTORY_HEADLESS=1`. No token is an `ARG`, an `ENV` or a layer; secrets arrive only as run-time environment.

## Run it

```sh
docker run --rm -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN \
  ghcr.io/on-par/factory-job:<version> \
  factory job --repo <owner>/<name> --issue <n> [--merge | --no-pr]
```

| Input                                             | Meaning                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GH_TOKEN`                                        | Required. Git and GitHub access (`gh auth setup-git`; the token is never put in the clone URL).          |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`   | One is required.                                                                                         |
| `--merge`                                         | Land the PR (squash-merge when CI is green). Without it the run stops at a PR. Exclusive with `--no-pr`. |
| `--no-pr`                                         | Stop after a clean CHECK: no push or PR.                                                                 |
| `--workdir <dir>`                                 | Parent of the clone (default `~/work`). The clone is `<dir>/<name>`; a non-empty directory is an error.  |
| `--factory-dir <dir>` / `FACTORY_JOB_FACTORY_DIR` | A mounted `.factory` directory holding `config.yaml` and/or `constitution.md`.                           |

`factory job` runs `gh auth setup-git`, writes `~/.claude.json` (onboarding done) when absent, clones the repo,
sets a local git identity if none is configured, then runs `factory run-issue <n> --in-place --json [--merge]` in
the clone. The clone's `.factory/state/` is git-excluded (and `.factory/` too when the repo has none).

## Config order

First match wins. The log line `factory job: config source: …; constitution source: …` names the winner.

| #   | Config source                               | Constitution source                               |
| --- | ------------------------------------------- | ------------------------------------------------- |
| 1   | `--config` / `FACTORY_CONFIG_PATH`          | `--constitution` / `FACTORY_CONSTITUTION_PATH`    |
| 2   | mounted `--factory-dir` config file         | mounted `--factory-dir`/`constitution.md`         |
| 3   | `FACTORY_CONFIG_YAML`                       | `FACTORY_CONSTITUTION`                            |
| 4   | the repo's committed `.factory/config.yaml` | the repo's `.factory/constitution.md`             |
| 5   | container defaults                          | the repo instruction files / bundled constitution |

`FACTORY_CONFIG_OVERRIDES` is merged over whichever config wins (the run config ladder, #3906); the log notes
that overrides are in effect. A `--factory-dir` with neither a config file nor `constitution.md` is an error.

**Container defaults** (only when nothing above supplies a config): `sandbox.runtime: none` (the container is the
sandbox) and `disk.minFreeGb: 2`. Containers typically have 16 GB of disk, so the stock 10 GB free-space floor would
hold every job; set `FACTORY_CONFIG_OVERRIDES` with `disk: { minFreeGb: <n> }` to change it.

## Output and exit codes

stderr carries progress. The last stdout line is one JSON object, validated by
[`job-status.schema.json`](../../packages/cli/schemas/job-status.schema.json): `schemaVersion`, `kind`
(`factory-job`), `repo`, `issue`, `outcome`, `merged`, `exitReason`, `exitCode`, `pr` (`{number, url}` or null),
`configSource`, `constitutionSource` and `timings` (`startedAt`, `finishedAt`, `cloneMs`, `runMs`, `totalMs`).

The process exits with the run's code: the `run-issue` codes (`0` success, `1`, and `10`–`16` for its other outcomes), or `2` for
a setup error (bad flags, missing secret, clone failure, or a run that ended without a result). A child killed by a signal
exits `1`. The status line's `outcome` and `exitReason` say why.

## Restarting an interrupted job

The first push happens in SHIP, after CHECK passes. Once the PR is open, the run saves its frozen plan in a hidden
factory-owned PR comment. A rerun on a fresh clone continues on the PR branch with no PLAN call, unless the issue body
changed since the plan was saved or the run was parked. A kill before the first push leaves nothing on the remote, so
the rerun starts over.

## Manual verification (after a release)

```sh
docker build --build-arg FACTORY_VERSION=<released version> -t factory-job docker/factory-job
docker run --rm factory-job sh -c 'id -u && factory --version && git --version && gh --version && claude --version'
docker run --rm -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN -e FACTORY_CONFIG_YAML \
  ghcr.io/on-par/factory-job:<version> factory job --repo on-par/foreman --issue <n> --merge
```

The first prints a non-zero uid and the tag's version. The second should exit 0 with `"merged": true` in the
final line. Set the GitHub package `ghcr.io/on-par/factory-job` to public once so hosts can pull it.
