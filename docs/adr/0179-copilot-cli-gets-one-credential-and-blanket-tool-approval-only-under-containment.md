# ADR-0179: Copilot CLI gets one credential and blanket tool approval only under containment

- Status: Accepted
- Date: 2026-11-21
- See also: [ADR-0178](0178-scoped-github-credentials-per-phase.md)

## Context

GitHub Copilot CLI is a built-in harness (`copilot-cli`). Two of its properties differ from the other agent CLIs.

1. **It authenticates with a GitHub token.** Copilot CLI reads `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, then a stored login. The factory strips every GitHub credential from agent child processes (`withoutGitHubCredentials`), so without an exception Copilot cannot authenticate from the environment. A broad exception would hand the factory's own GitHub token, which can push and open PRs, to an agent.
2. **Its tool approval is all or nothing in a headless run.** Without `--allow-all` (or the narrower `--allow-*` flags), a non-interactive run denies every tool call that needs approval, so BUILD cannot edit files. With `--allow-all` the agent may run any tool, read or write any path and reach any URL. The other harnesses already run with permission prompts off. For Copilot the factory has to decide when to grant this.

A sandbox policy being present is not enough to tell whether the run is contained. `runtime: none` wraps nothing, and `docker-sandbox` does not wrap the command yet. A disposable one-job container has no OS sandbox inside it, but it is isolated.

## Decision

1. **One credential, one direction.** `ExecFn` and `childProcessEnv` take a `copilotAuth` option. When it is set, the child keeps exactly `COPILOT_GITHUB_TOKEN`, read from the factory's own environment, and still loses every other GitHub credential. A `COPILOT_GITHUB_TOKEN` passed through a lane's `env` overrides is dropped. Only the `copilot-cli` harness sets `copilotAuth`, and it never sets `githubAuth`. Every other harness keeps the default, so Claude Code, Codex, OpenCode and Pi never receive `COPILOT_GITHUB_TOKEN`. `isGitHubCredentialEnvVar('COPILOT_GITHUB_TOKEN')` stays true, so redaction still masks the value. The harness also passes `--secret-env-vars=COPILOT_GITHUB_TOKEN`, so Copilot keeps the value out of its own shell and MCP environments.
2. **Blanket tool approval only under containment.** The harness passes `--allow-all` only when the run's sandbox runtime is `sandbox-exec` or `firejail`, or when the config sets `sandbox.copilotAllowAll: true`. That key is config-only and defaults to off. No environment variable can grant it, which follows the `FACTORY_CODEX_FULL_ACCESS` precedent. The harness removes `COPILOT_ALLOW_ALL`, `COPILOT_ASSISTED_APPROVAL`, `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS`, `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP` and `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS` from the child environment, so a repository's hooks, workspace MCP servers and extensions do not load and no environment variable can grant tool approval to the child. The decision and its reason are logged once per task.
3. **`--no-ask-user` always.** The agent never waits for an answer. `ESCALATE:` lines in the final message keep their existing meaning, so the harness returns the final assistant message verbatim.

## Consequences

- On a host with no OS sandbox and no opt-in, Copilot runs without blanket approval. A tool call that nobody can approve ends the run as `permission_denied`, and the message names the missing containment instead of failing silently.
- The factory does not override Copilot's own configuration, so approvals and settings the operator owns still apply to the child: command approvals saved in `~/.copilot/permissions-config.json`, permanent URL approvals in `allowedUrls` in `settings.json`, user-level `permissionRequest` hooks, folders listed in `trustedFolders` in `config.json` (which load that folder's hooks and workspace MCP servers), and a `COPILOT_HOME` that points at any of these files. A run without `--allow-all` can still have tool calls approved this way. An isolated runtime should start from a fresh Copilot home.
- An operator who runs the factory inside an isolated runtime, such as a disposable one-job container, sets `sandbox.copilotAllowAll: true` in that runtime's config. Docs describe it as granting all tool permissions, for use only inside an isolated runtime.
- A rejected or missing `COPILOT_GITHUB_TOKEN` cannot fall back to the factory's `GITHUB_TOKEN` or `GH_TOKEN`, because neither reaches the child. A stored `copilot login` and Copilot's last-resort `gh auth token` fallback stay reachable outside the OS sandbox. Inside it, `~/.config/gh` is unreadable.
- If `docker-sandbox` later wraps commands, it can join the containing runtimes in one place (`copilotAllowAllDecision`).
