# Coding agent setup

This guide covers installing, signing in and configuring each supported coding agent CLI
(Claude Code, Codex and OpenCode) for the factory. See [models.md](models.md) for model routing
and [harness-contract.md](harness-contract.md) for the adapter contract. To declare your own CLI,
see "Declaring a custom harness" in [models.md](models.md).

## Harness matrix

| Agent                        | Harness id             | Install and auth                                                                            | Phases                                                                                            | Sandbox                                                                                    | Usage and cost                                                                  | Rate-limit classification                                           | CI coverage                                                                  | Status         |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------- |
| Claude Code                  | `claude-cli`           | `claude` on PATH; `/login` in `claude` or `ANTHROPIC_API_KEY`                               | PLAN, BUILD (`build_claude`), CHECK, review, triage (triage always runs `claude -p`)              | Yes, the command is wrapped in the outer sandbox                                           | Tokens, cache tokens, turns, durations and cost from the JSON result envelope   | `classifyFailure`, plus `unavailable` for a zero-token error result | Contract tests in the required `ci` check; nightly evals install Claude Code | `supported`    |
| Codex                        | `codex-cli`            | `codex` on PATH; `codex login`, `codex login --with-api-key` or `codex login --device-auth` | PLAN, BUILD (`build_codex`), CHECK, review, triage                                                | Yes: outer sandbox plus `--sandbox workspace-write` (`danger-full-access` without runtime) | Tokens from `turn.completed` events; no cost field, so cost uses registry price | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `supported`    |
| OpenCode                     | `opencode`             | `opencode` on PATH; `opencode auth login`, `OPENCODE_API_KEY` optional                      | PLAN, BUILD (`build_opencode`), CHECK, review, triage when pinned; needs `FACTORY_EXPERIMENTAL=1` | No, the adapter does not take the sandbox request                                          | Tokens and cost summed from `step_finish` events                                | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (prompt-only)         | `ollama-http`          | Ollama server running locally, no login                                                     | PLAN, CHECK, review, triage; not BUILD (not agentic)                                              | No, it makes no file edits                                                                 | Not reported                                                                    | `classifyFailure` on the HTTP status and body                       | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (agentic)             | `ollama-agentic`       | Ollama server running locally, no login                                                     | BUILD plus the other phases (agentic)                                                             | No                                                                                         | Not reported                                                                    | `classifyFailure`                                                   | Contract tests in the required `ci` check                                    | `experimental` |
| Ollama (command-loop worker) | `ollama-command-agent` | Ollama server running locally, no login                                                     | BUILD (internal adapter in the model executor)                                                    | No                                                                                         | Not reported                                                                    | Router `classifyFailure` on the error text and exit code            | None, it is not extracted into a coding harness                              | `experimental` |
| Declared custom harness      | `command`              | Your CLI on PATH, declared under `harnesses:` with an optional `probe`                      | Any phase, through the declared `agentic` setting                                                 | Yes, the command is wrapped in the outer sandbox                                           | `usage: jsonl` or none                                                          | Declared `errorPatterns`, then `classifyFailure`                    | Contract tests in the required `ci` check                                    | `supported`    |

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
`claude CLI` and `claude auth (host)`. Doctor does not print CLI versions; check them with `claude --version`.

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

Run `factory doctor` in the repo. Look for the `codex auth` line (it names the sign-in method) and
`codex sandbox`. Doctor does not print CLI versions; check them with `codex --version`.

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

### Verify with `factory doctor`

Run `factory doctor` in the repo. The `coding agent` line lists `opencode`. `factory models --doctor`
probes OpenCode reachability. Doctor does not print CLI versions; check them with `opencode --version`.

Version tested: 1.18.28
