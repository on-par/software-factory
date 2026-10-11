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

### Fixed

- The `Publish` workflow can no longer go green without publishing. When the
  v1.0 blockers are open, the ref is not a `v*` tag, or `npm publish` fails,
  the job fails. Every run writes `PUBLISHED <name@version ...>` or
  `NOT PUBLISHED: <reason>` to the job summary and sets the step output
  `published=true|false`. A manual run (`workflow_dispatch`, dry run by
  default) packs every package and reports `dry-run, not published` (#2335).

### Removed

- Removed the bundled `camp-somewhere-cli` constitution. This was a breaking
  change for anyone relying on the bundled constitution for that product; seed
  your own repo's constitution instead with `factory constitution --init <product>`.

### Packaging

- Every published `@on-par/*` tarball now carries a README and the MIT
  LICENSE, and ships `dist/` only: no test files, no `src/`, no
  `.tsbuildinfo`, and no `factory-core` test-support kit (#2336).
  `@on-par/factory-config` now bundles its constitution markdown under
  `dist/constitutions/` (the `./constitutions/*` export points there).
  `@on-par/factory-core/testing` stays the documented home for test doubles.
- `npm pack` (and so `npm publish`) fails when a package has no built `dist/`,
  instead of producing a tarball that holds only `package.json`.
