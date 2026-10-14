# Coding agent setup

This guide covers installing, signing in and configuring each supported coding agent CLI
(Claude Code, Codex and OpenCode) for the factory. See [models.md](models.md) for model routing
and [harness-contract.md](harness-contract.md) for the adapter contract. To bring your own CLI,
see [Bring your own agent](#bring-your-own-agent).

## Harness matrix

| Agent                        | Harness id             | Install and auth                                                                            | Phases                                                                                            | Sandbox                                                                                    | Usage and cost                                                                  | Rate-limit classification                                           | CI coverage                                                                  | Status         |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------- |
| Claude Code                  | `claude-cli`           | `claude` on PATH; `/login` in `claude` or `ANTHROPIC_API_KEY`                               | PLAN, BUILD (`build_claude`), CHECK, review, triage (triage always runs `claude -p`)              | Yes, the command is wrapped in the outer sandbox                                           | Tokens, cache tokens, turns, durations and cost from the JSON result envelope   | `classifyFailure`, plus `unavailable` for a zero-token error result | Contract tests in the required `ci` check; nightly evals install Claude Code | `supported`    |
| Codex                        | `codex-cli`            | `codex` on PATH; `codex login`, `codex login --with-api-key` or `codex login --device-auth` | PLAN, BUILD (`build_codex`), CHECK, review, triage                                                | Yes: outer sandbox plus `--sandbox workspace-write` (`danger-full-access` without runtime) | Tokens from `turn.completed` events; no cost field, so cost uses registry price | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `supported`    |
| OpenCode                     | `opencode`             | `opencode` on PATH; `opencode auth login`, `OPENCODE_API_KEY` optional                      | PLAN, BUILD (`build_opencode`), CHECK, review, triage when pinned; needs `FACTORY_EXPERIMENTAL=1` | No, the adapter does not take the sandbox request                                          | Tokens and cost summed from `step_finish` events                                | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (prompt-only)         | `ollama-http`          | Ollama server running locally, no login                                                     | PLAN, CHECK, review, triage; not BUILD (not agentic)                                              | No, it makes no file edits                                                                 | Not reported                                                                    | `classifyFailure` on the HTTP status and body                       | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (agentic)             | `ollama-agentic`       | Ollama server running locally, no login                                                     | BUILD plus the other phases (agentic)                                                             | No                                                                                         | Not reported                                                                    | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (command-loop worker) | `ollama-command-agent` | Ollama server running locally, no login                                                     | BUILD (internal adapter in the model executor)                                                    | No                                                                                         | Not reported                                                                    | Router `classifyFailure` on the error text and exit code            | None, it is not extracted into a coding harness                              | `experimental` |
| Declared custom harness      | `command`              | Your CLI on PATH, declared under `harnesses:` with an optional `probe`                      | PLAN, CHECK, review, triage; BUILD (`build_command`) only when declared `agentic: true`           | Yes, the command is wrapped in the outer sandbox                                           | `usage: jsonl` or none                                                          | Declared `errorPatterns`, then `classifyFailure`                    | Contract tests in the required `ci` check                                    | `supported`    |

## Claude Code

### Install and log in

Install the CLI, for example `npm install -g @anthropic-ai/claude-code`. Then run `claude` and complete
`/login`, or set `ANTHROPIC_API_KEY`.

### Minimal `.factory/config.yaml`

```yaml
version: 2
models:
  pins:
    plan: claude-sonnet-5
    build: claude-sonnet-5
    checker: claude-sonnet-5
    triage: claude-sonnet-5
route: claude
```

### Verify with `factory doctor`

Run `factory doctor` in the repo. Look for a `coding agent` line showing `claude` found, plus
the `Claude Code` section with `claude installed` (it shows the CLI version), and `claude signed in` (local login evidence only, no model call; run `factory doctor --probe-inference` to also send one real `claude -p` prompt).

Version tested: 2.1.296 (Claude Code)

## Codex

### Install and log in

Install the CLI, for example `npm install -g @openai/codex`. Then run `codex login` (ChatGPT),
`codex login --with-api-key`, or `codex login --device-auth`.

### Minimal `.factory/config.yaml`

```yaml
version: 2
models:
  pins:
    plan: gpt-5.6-terra-high
    build: gpt-5.6-terra-medium
route: codex
```

### Verify with `factory doctor`

Run `factory doctor` in the repo. Look for the `Codex` section with `codex installed` (it shows the CLI
version), the `codex signed in` line (it names the sign-in method) and `codex sandbox`.

Version tested: codex-cli 0.155.1

## OpenCode

### Install and log in

Install OpenCode following [opencode.ai](https://opencode.ai), then run `opencode auth login`.
`OPENCODE_API_KEY` is an optional override. OpenCode models are experimental, so set
`FACTORY_EXPERIMENTAL=1` in the factory's environment.

### Minimal `.factory/config.yaml`

```yaml
version: 2
models:
  pins:
    plan: opencode-deepseek-v4-flash
    build: opencode-deepseek-v4-flash
    checker: opencode-deepseek-v4-flash
    triage: opencode-deepseek-v4-flash
route: opencode
```

### Effort

`models.efforts` for an OpenCode model is passed as `--variant <effort>` on OpenCode 1.x, and as
`--model '<provider/model>#<effort>'` on 2.x. The factory reads `opencode --version` once per run
process; when the version is unknown it uses the 1.x form. On 2.x a model with no `providerModel`
runs without effort.

### Verify with `factory doctor`

Run `factory doctor` in the repo. The `coding agent` line lists `opencode`, and the `OpenCode` section
shows `opencode installed` and `opencode signed in`. `factory models --doctor` probes OpenCode reachability.

Version tested: 1.18.28

## Recipes

Each recipe is a complete, minimal `.factory/config.yaml`. Copy it to the repo, then run `factory doctor`.
The `Version tested:` line names the CLI versions the recipe was checked with. CI loads every recipe
and fails if it stops parsing or pins an unknown model.

### Recipe: Claude-only

Use this when Claude Code is the only agent you have. The pins and `providers` switches keep every tier on Claude.

```yaml
version: 2
models:
  pins:
    plan: claude-sonnet-5
    build: claude-sonnet-5
    checker: claude-sonnet-5
    triage: claude-sonnet-5
route: claude
providers:
  openai: false
  ollama: false
```

Version tested: 2.1.296 (Claude Code)

### Recipe: Codex-only

Use this when Codex is the only agent you have. Triage runs the pinned `triage` model, so on a
Codex-only host it runs through Codex and does not need `claude`.

```yaml
version: 2
models:
  pins:
    plan: gpt-5.6-terra-high
    build: gpt-5.6-terra-medium
    checker: gpt-5.6-luna-high
    triage: gpt-5.6-luna-high
route: codex
providers:
  anthropic: false
  ollama: false
```

Version tested: codex-cli 0.155.1

### Recipe: OpenCode Go-only

Use this with an OpenCode Go subscription (the pinned model is served as `opencode-go/deepseek-v4-flash`).
Set `FACTORY_EXPERIMENTAL=1` in the factory's environment and sign in with `opencode auth login`, or set `OPENCODE_API_KEY`.
Do not switch off every provider: that empties the boss tier and the config fails to load. The pins keep it OpenCode-only.

```yaml
version: 2
models:
  pins:
    plan: opencode-deepseek-v4-flash
    build: opencode-deepseek-v4-flash
    checker: opencode-deepseek-v4-flash
    triage: opencode-deepseek-v4-flash
route: opencode
```

Version tested: 1.18.28

### Recipe: Local Ollama

Use this to run on local models only. Set `FACTORY_EXPERIMENTAL=1`, start the server with `ollama serve`, and
`ollama pull` each model (`qwen2.5-coder:14b`, `qwen3.5:9b`). BUILD uses the `ollama-agentic` harness, which
is codex-eligible, so the route is `codex`.

```yaml
version: 2
models:
  pins:
    plan: qwen2.5-coder:14b
    build: codex-ollama-qwen3.5:9b
    checker: qwen3.5:9b
    triage: qwen2.5-coder:14b
route: codex
```

Version tested: ollama (version not recorded: `ollama --version` was not available on the build host; run it and compare)

### Recipe: Mixed

Use this to put each phase on the agent that suits it: Claude plans and triages, Codex builds, and a local Ollama model checks.

```yaml
version: 2
models:
  pins:
    plan: claude-sonnet-5
    build: gpt-5.6-terra-medium
    checker: qwen3.5:9b
    triage: claude-sonnet-5
route: codex
```

Version tested: 2.1.296 (Claude Code), codex-cli 0.155.1, ollama (version not recorded, see the local Ollama recipe)

## Bring your own agent

Any CLI that reads a prompt and edits the worktree can run through the built-in `command` harness. No code
change is needed: you declare the command, point a model at it, pin the model and check it. The field
reference is "Declaring a custom harness" in [models.md](models.md). The contract is in
[harness-contract.md](harness-contract.md).

### 1. Declare the harness and a model

Put the harness, a model on it and the pins in one `.factory/config.yaml`:

```yaml
version: 2
harnesses:
  my-agent:
    command: ./scripts/my-agent.sh
    prompt: stdin
    output: jsonl-last-message
    agentic: true
    usage: none
    errorPatterns:
      rate_limit: '429|rate limit'
    probe: my-agent --version
models:
  registry:
    my-agent-model:
      provider: custom
      harness: my-agent
      tier: worker
      costPerMtokInput: 0
      costPerMtokOutput: 0
      contextWindow: 200000
      capabilities: [implementation]
      envKey: null
  pins:
    plan: my-agent-model
    build: my-agent-model
    checker: my-agent-model
```

Leave `route` unset; the factory derives `command` from the build pin.

The command can be a small wrapper that reads the prompt on stdin, runs the agent in the worktree (the
working directory) and prints one JSON line per message. For example, `scripts/my-agent.sh`:

```bash
#!/usr/bin/env bash
# Read the prompt on stdin, run the agent in the worktree (cwd), print one JSON line per message.
set -euo pipefail
prompt=$(cat)
reply=$(my-agent --non-interactive "$prompt")
jq -cn --arg text "$reply" '{type: "message", text: $text}'
```

With `output: jsonl-last-message` the factory returns the text of the last JSON line that carries `text`,
`result`, `message` or `content`, so progress lines before it are ignored.

### 2. Pin plan, build and checker

The `pins` in the block above send PLAN, BUILD and CHECK to your model. BUILD needs `agentic: true`; a
non-agentic build pin is refused when config loads. BUILD runs the `build_command` task and leaves commits
only. SHIP publishes.

### 3. Run `factory doctor`

`factory doctor` runs the `probe` command and reports the harness as available, unavailable or unverified.
It counts an agentic declared harness as the coding agent when the first word of `command` is on PATH.

### 4. Run `factory harness check my-agent`

`factory harness check my-agent` runs the contract scenarios against your declared CLI and reports pass or
fail per scenario. See [Testing a harness](harness-contract.md#testing-a-harness).

### 5. Run `factory run`

Start the factory with `factory run`. PLAN, BUILD and CHECK use the pinned model on your harness.

### Request support instead

If you would rather have the factory ship the adapter, open a
[Request support for a coding agent](https://github.com/on-par/software-factory/issues/new?template=agent-support.yml)
issue. The form is defined in [`.github/ISSUE_TEMPLATE/agent-support.yml`](../.github/ISSUE_TEMPLATE/agent-support.yml).
