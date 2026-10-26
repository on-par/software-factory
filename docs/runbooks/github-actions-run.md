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
    uses: on-par/software-factory/.github/workflows/factory-run.yml@v0.9.18
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

## FACTORY_GITHUB_TOKEN

Create a fine-grained PAT scoped to the caller repo with Contents, Pull requests and Issues
read/write (plus Workflows if the repo edits workflows) and store it as the repo secret
`FACTORY_GITHUB_TOKEN`. There is no `GITHUB_TOKEN` fallback: PRs opened with the Actions token never
trigger the required `ci` check, so the run exits 2 without it. A GitHub App installation token
(for example via `actions/create-github-app-token`) is the preferred option later.

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

## Artifacts

`factory-run-log` holds the run log and `.factory/events.ndjson`, kept 14 days. No state (runs,
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
