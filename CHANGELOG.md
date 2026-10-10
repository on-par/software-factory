# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Security

- Agent CLI child processes (claude, codex, opencode), the commands they
  propose, and checker commands no longer inherit GitHub credentials
  (`GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN` and other `GITHUB_*`/`GH_*` token, PAT, secret or
  private-key variables). Only the factory's own `gh`/`git` calls receive them.
  Failed-command errors and output have GitHub credentials redacted. If a
  repo's build or test command needed `GITHUB_TOKEN`, it no longer gets it from
  the factory's environment.

### Removed

- Removed the bundled `camp-somewhere-cli` constitution. This was a breaking
  change for anyone relying on the bundled constitution for that product; seed
  your own repo's constitution instead with `factory constitution --init <product>`.
