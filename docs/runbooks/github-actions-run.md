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
    uses: on-par/software-factory/.github/workflows/factory-run.yml@v0.9.4
    permissions: { contents: write, pull-requests: write, issues: write }
    with:
      command: run-issue
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

Inputs reach the wrapper only through step `env`, never interpolated into shell.

## FACTORY_GITHUB_TOKEN

Create a fine-grained PAT scoped to the caller repo with Contents, Pull requests and Issues
read/write (plus Workflows if the repo edits workflows) and store it as the repo secret
`FACTORY_GITHUB_TOKEN`. There is no `GITHUB_TOKEN` fallback: PRs opened with the Actions token never
trigger the required `ci` check, so the run exits 2 without it. A GitHub App installation token
(for example via `actions/create-github-app-token`) is the preferred option later.

## Claude auth

Set one of `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`.

## Cost and limits

Every run spends the caller repo's Actions minutes for up to the 120-minute job timeout (GitHub's job
cap is 6 h). Claude usage is billed to the given credential.

## Artifacts

`factory-run-log` holds the run log and `.factory/events.ndjson`, kept 14 days. No state (runs,
baseline cache) persists between runs.

## Pinning

Always pin `@vX.Y.Z`; the workflow installs the matching `@on-par/factory-cli` version.
