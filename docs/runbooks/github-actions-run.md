# Run a factory command on a GitHub-hosted runner

`.github/workflows/factory-run.yml` is a reusable workflow (`workflow_call`) that runs one
allowlisted factory command (`run-issue <n>`, `ship <n>`, `doctor`) on a GitHub-hosted runner.
It is one-shot and opt-in: no queue claiming, no schedule, no automatic trigger.

## Example caller

Add this to the caller repo as `.github/workflows/factory.yml`:

```yaml
name: Factory run
on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
jobs:
  factory:
    uses: on-par/software-factory/.github/workflows/factory-run.yml@v0.9.34
    permissions: { contents: write, pull-requests: write, issues: write }
    with:
      command: run-issue
      provider: claude-cli
      issue: ${{ inputs.issue }}
    secrets:
      FACTORY_GITHUB_TOKEN: ${{ secrets.FACTORY_GITHUB_TOKEN }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The called job's `permissions:` cannot exceed the caller's, so keep the `permissions:` line when the
repo default is read-only. The workflow checks out its own scripts into `.factory-action/`, an
untracked directory in the caller checkout; add `.factory-action/` to the caller's `.gitignore`.
The factory only commits in lane worktrees, so it is never committed.

A fresh runner checkout has no git identity, and `factory doctor` fails without one.
`factory-run.yml` sets the checkout's local git identity to `Software Factory Actions` /
`factory-actions[bot]@users.noreply.github.com` before it calls `factory-run.sh`, so a
caller that pins the script from an older tag (including this repo's dogfood workflow)
still clears `git identity` as soon as the workflow file itself is on the branch in use.
`factory-run.sh` also sets any missing `user.name` or `user.email` the same way for
pinned external callers after the next CLI tag. A field that is already set, locally or
globally, is left alone by the script path, so set your own identity in an earlier step
to override it.

## Inputs

- `command`: `run-issue` (default), `ship` or `doctor`. Anything else exits 2 with `command not allowed: <cmd>`.
- `issue`: positive integer, required for `run-issue` and `ship`, rejected for `doctor`. Exit 2 with
  `issue must be a positive integer: <value>` or `issue is required for <cmd>`.

- `provider`: `claude-cli` (default), `codex-cli`, `opencode` or `pi`. Anything else exits 2 with
  `provider not allowed: <value>`.
- `experimental`: boolean, default `false`. Must be `true` for `opencode` and `pi`.
- `plan_model`, `build_model`: optional overrides for `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL`;
  empty uses the provider default below.

Inputs reach the wrapper only through step `env`, never interpolated into shell.

## Config

`.factory/config.yaml` is optional. When the caller repo has none, the packaged defaults apply.
For your real product standards, commit `.factory/config.yaml` and `.factory/constitution.md`
to the caller repo. `factory init` does not exclude those paths; only `.factory/state/` is
ignored, via `.factory/.gitignore`. Alternatively, run `factory init` in the job before the
factory command. A job that calls `factory-run.yml` with `uses:` cannot add steps, so that
route needs a job of your own that installs the CLI. The workflow does not expose an input
for each config key: `provider`, `plan_model` and `build_model` are the only model settings on the
workflow. Put everything else in `.factory/config.yaml`.

## FACTORY_GITHUB_TOKEN

Create a fine-grained PAT scoped to the caller repo with Contents, Pull requests and Issues
read/write (plus Workflows if the repo edits workflows) and store it as the repo secret
`FACTORY_GITHUB_TOKEN`. There is no `GITHUB_TOKEN` fallback: PRs opened with the Actions token never
trigger the required `ci` check, so the run exits 2 without it. A GitHub App installation token
(for example via `actions/create-github-app-token`) is the preferred option later.

The workflow's caller-repo checkout uses this token too, so `git push` from `run-issue` and `ship`
(not just PRs) runs as the PAT owner, and `factory-run.sh` forces the same credential for git. Pushes
made with the Actions token leave follow-up `pull_request` workflows at `action_required` with no jobs,
so the required `ci` check never reports. A ship that ends "left as draft (CI pending)" fails the
run (exit 1) and is not a land.
A local `factory run` with auto-merge lands such a CI-pending draft in the same lane (base sync, ready flip, CI verification, merge) and adopts it after a restart without rebuilding (`ship.ciWatchMinutes` sets the watch window). With auto-merge off, the between-issue sweep marks it ready for a human. The one-shot Actions job still exits 1.

## Merging

The `Run factory` step sets `FACTORY_MERGE=1` and `FACTORY_MERGE_ADMIN=1`, so a hosted run merges its
green PR and uses admin privileges to merge through unmet requirements when `FACTORY_GITHUB_TOKEN`
allows it. See [SECURITY.md](../../SECURITY.md#merge-is-opt-in) for what `FACTORY_MERGE_ADMIN` permits.
Callers that pin `@vX.Y.Z` get this from the first tag published with it.

`factory run-issue` and `factory ship` stop at a ready-for-review PR and never merge. With
`FACTORY_MERGE=1`, `scripts/factory-run.sh` runs `factory land <issue>` in the same job after they
exit 0, so an Actions run-issue or ship is ship then land:

- A PR left as draft is not landed. "Left as draft (CI pending)" still fails the job with exit 1.
- When land fails, the job fails with land's exit code and an `::error::` line, also written to the
  step summary.
- `FACTORY_MERGE` unset, or any value other than `1`, skips land. `doctor` never lands.
- `land` is not a `command` input. The workflow still rejects it.

A one-shot host that has no `land` retry loop can run `factory run-issue <N> --merge` (or
`run-brief <file> --merge`) instead. After SHIP it waits for CI and lands the PR through the
`factory run --auto-merge` gates (CI, base CI, risk tier, `no-auto-merge`/`needs-human` labels, the
PR classifier), bounded by `--merge-timeout <30m|2h>` or `ci.awaitingCiCapHours`. `--admin` merges
past unmet branch protection but never past red CI. It exits:

| Exit | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | merged                                                          |
| 1    | parked or failed before a PR                                    |
| 2    | usage error (for example `--merge` with `--no-pr` or `--stack`) |
| 10   | held by a gate (risk, label, draft); the PR stays open          |
| 11   | CI failed                                                       |
| 12   | timed out waiting for CI or merge                               |
| 13   | land failed                                                     |
| 14   | land deferred: the base kept moving until the timeout           |

## Providers and secrets

Each provider reads only its own repo secrets, under the names the Claude GitHub App and
openai/codex-action already create. The wrapper installs the selected provider CLI after all checks pass.

| provider     | secret(s)                                        | default plan model                | default build model               | experimental |
| ------------ | ------------------------------------------------ | --------------------------------- | --------------------------------- | ------------ |
| `claude-cli` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `claude-opus-5`                   | `claude-sonnet-5`                 | no           |
| `codex-cli`  | `OPENAI_API_KEY` (or alias `CODEX_API_KEY`)      | `gpt-5.6-terra-high`              | `gpt-5.6-sol`                     | no           |
| `opencode`   | `OPENCODE_API_KEY`                               | `opencode-deepseek-v4-flash`      | `opencode-deepseek-v4-flash`      | yes          |
| `pi`         | `OPENROUTER_API_KEY`                             | `pi-openrouter-deepseek-v4-flash` | `pi-openrouter-deepseek-v4-flash` | yes          |

- **Codex alias rule.** `OPENAI_API_KEY` is canonical (the codex-action name); `CODEX_API_KEY` is an
  alias. When both are set and differ, the run warns and uses `OPENAI_API_KEY`.
- **Experimental gate.** `opencode` and `pi` require `experimental: true`, which exports
  `FACTORY_EXPERIMENTAL=1`. Without it the run exits 2.
- **Fail fast.** A missing provider secret, an unknown provider or a missing experimental opt-in exits 2
  before anything is installed. This includes a Claude run (even `doctor`) with neither Claude secret.
- **Isolation.** Secrets of other providers are never mapped into the step and are unset by the wrapper.
- **Claude GitHub App repos** already have `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and need no
  new model secret. The App's permissions do not transfer to this workflow, so PRs are opened with
  `FACTORY_GITHUB_TOKEN`.
- **Copilot and Ollama** are not offered.

Docs: <https://code.claude.com/docs/en/github-actions>,
<https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md>,
<https://github.com/openai/codex-action/blob/main/README.md>.

## Cost and limits

Every run spends the caller repo's Actions minutes for up to the 120-minute job timeout (GitHub's job
cap is 6 h). Claude usage is billed to the given credential.

## Hosts whose disk does not survive

A one-shot host (a container that is destroyed after the run) can pass `--json` and `--export <dir>` to
`factory run-issue`, `run-brief` or `ship`. `--json` prints the final result (outcome, PR, SHAs, phase
timings, cost in USD; outcome `land-deferred` with a `landDeferrals` count when the base kept moving until the `--merge` timeout, exit 14) as one `schemaVersion 1` line on stdout and moves progress to stderr; the schema is
`schemas/run-result.schema.json`. `--export` copies the run's state file, events, costs and `run-result.json`
into `<dir>` on every exit path, so the host can upload them before it exits. Neither flag changes the exit code.

### One issue to a terminal outcome

`factory run --issue <N> [--wait stay|exit] [--max-wait <30m|2h>] [--admin] [--json] [--export <dir>]`
carries one issue to the end of its life on GitHub. With no PR for the issue it ships one; with an
open PR (a re-run) it ships nothing and restores the PR's run state. It honours the repo's merge
policy (`run.merge.auto`, `--auto-merge`/`--no-auto-merge`, risk tier, `no-auto-merge`/`needs-human`
labels, the PR classifier): when auto-merge is on it waits for CI and merges, and a PR held by a gate
waits for a human. When auto-merge is off it never merges. Trusted feedback on the PR runs a feedback
round (like `factory respond`) that pushes to the same PR.

`--wait stay` (default) polls in-process until the PR is merged, closed or `--max-wait` elapses.
`--wait exit` handles any pending feedback once, saves status `awaiting-review` to the PR's run-state
comment and exits, so the host can stop the container and run the same command on the next PR event.
Exit codes:

| Exit | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| 0    | merged                                                                                              |
| 1    | parked (ship parked, a merge failed, or the review-rework cap was reached)                          |
| 2    | usage error (`--wait` not stay or exit, lifecycle flags without `--issue`)                          |
| 15   | closed without merging                                                                              |
| 16   | awaiting review: the PR is open with no unhandled feedback (`--wait exit`, or `--max-wait` elapsed) |

Re-run contract: a re-run on a fresh clone finds the issue's factory PR on GitHub, reuses it, does not
build or open a second PR, and handles only feedback no earlier round marked handled. A merged or
closed PR is never shipped again. `--json` reports outcomes `merged`, `closed`, `parked` and
`awaiting-review` (PR state `closed` is new; `schemaVersion` stays 2).

## Artifacts

`factory-run-log` holds the run log and `.factory/state/events.ndjson`, kept 14 days. No state (runs,
baseline cache) persists between runs.

## Pinning

Always pin `@vX.Y.Z`. Pin the tag of the CLI you want: at that tag, `FACTORY_CLI_VERSION` in
`factory-run.yml` equals the tag's version, and the workflow installs that `@on-par/factory-cli`
version and checks out that tag's scripts.

## Dogfooding in this repo

Software Factory runs the workflow on itself through `.github/workflows/factory.yml`. That caller
has only a `workflow_dispatch` trigger and calls the workflow by relative path,
`uses: ./.github/workflows/factory-run.yml`, not by a tag. It passes every input and secret through.
It still installs `FACTORY_CLI_VERSION` and checks out tag `v<FACTORY_CLI_VERSION>`, so it works
only after that version is tagged and published. External repos keep the pinned `@vX.Y.Z` pattern
shown above.

This repo commits `.factory/config.yaml` and `.factory/constitution.md`, so the runner checkout
has them and `factory doctor` passes `.factory initialized`. The root `.gitignore` does not ignore
`.factory/`. Only runtime state is ignored, by `.factory/.gitignore`, which contains just
`state/`. Do not add `.factory/` back to the root `.gitignore`: the dogfood run then has no config.
