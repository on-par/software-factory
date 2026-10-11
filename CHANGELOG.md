# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## 0.9.2

Public-repo cleanup and first-run reliability fixes. All seven published
`@on-par` packages move to 0.9.2 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Changed

- `factory feedback` files its issue in your own repo: `--repo owner/name`,
  then the new `filing.repo` config key, then the checkout's `origin` remote.
  It no longer falls back to on-par/software-factory; with no repo it stops
  with a clear error. The issue leaves out your host name and local design and
  log paths unless you pass `--include-local-paths` (#2398).
- Upstream factory reports have no built-in target repo either. Without an
  explicit repo they are skipped with reason `no-target-repo` (#2398).
- Public-repo cleanup: removed internal operations notes and research from
  the docs and fixed broken doc links (#2398).
- The CLI refuses to start on Node below 24 with a clear message, before it
  loads `node:sqlite` (#2390).
- `factory doctor` runs outside a repo, checks your git identity, and warns
  when no sandbox runtime is available (#2391).
- Readiness keeps the original issue body when enriching it and adds an
  opt-out (#2395).

### Added

- factoryd checks for updates every 30 minutes, drains, self-updates and
  restarts via launchd, and skips versions that failed (#2375).

### Fixed

- The model router skips Ollama models when Ollama is unreachable, and triage
  logs the model it actually runs (#2394).
- `factory ship` detects a repo with no CI checks early and logs CI wait
  progress (#2396).

## 0.9.1

Docs and metadata refresh for the npm page, plus the factory changes merged
since 0.9.0. All seven published `@on-par` packages move to 0.9.1 in lockstep.
Install or update with `npm install -g @on-par/factory-cli@latest`.

### Changed

- README rewrite for On PAR Dev's Software Factory: npm install Quick Start
  (`npm install -g @on-par/factory-cli`, `factory --version`, `factory doctor`),
  an accurate pitch, prerequisites (Claude Code signed in, `gh auth login`),
  and the safety note moved up under Quick Start. The `@on-par/factory-cli`
  README that npm shows, CONTRIBUTING.md and SECURITY.md match it (#2377,
  #2352, #2374).
- `@on-par/factory-cli` has a new npm description and keywords (#2377).
- Both READMEs open with a short GIF of a factory run (#2379).
- The footer the factory adds to its PR bodies now says "On PAR Dev's
  Software Factory" (#2377).
- KPIs count landed and admin-merged factory PRs as merges (#2373).

### Added

- `factory self-update --check [--json]` compares the running version with
  the npm `latest` dist-tag. It only reports; it installs nothing (#2370).
  Installing updates is still planned (#2355).
- `factory daemon run --update-mode manual|stable|prerelease` (default
  `stable` on npm installs) and `factory status` showing the update mode,
  current and available version and last update result. The mode is recorded
  only; factoryd does not install updates yet (#2367, #2372).
- Base holds: an environment pause persists a hold on the base SHA, claims
  are refused while it is active, `factory status` shows it, and it clears on
  a new SHA or green main CI (#2353, #2357, #2359, #2360).
- A pre-PLAN main-health check, cached per base SHA (#2362).
- State and config can live outside the checkout (`stateRoot` via flag or
  env), so a repo needs no in-repo `.factory/` (#2358).
- Infrastructure CI failures are classified separately from test failures,
  rerun once per PR head SHA, and parked as `ci-infra` (skipped by the
  steward) when they repeat (#2368, #2369, #2371).

### Fixed

- Reclaiming an issue released by an environment pause reuses its frozen
  plan instead of planning again (#2376).

## 0.9.0

First npm release of the seven `@on-par` packages (`adr-kit`, `contracts`,
`repo-context`, `factory-config`, `factory-core`, `factory-tui`,
`factory-cli`). Versioning restarts at 0.9.0; nothing was published before,
and 1.0 follows once the release is proven.

### Changed

- Every workspace is now at version 0.9.0 (was 2.0.0), with `^0.9.0` ranges
  between the `@on-par` packages. `factory --version` prints 0.9.0 (#2244).
- The `Publish` workflow takes its version and npm dist-tag from the tag name:
  `vX.Y.Z-next.N` publishes `X.Y.Z-next.N` to `next`, `vX.Y.Z` publishes
  `X.Y.Z` to `latest`, and any other tag fails. `scripts/set-release-version.sh`
  sets the seven packages to one version with exact internal pins (and fails,
  naming the package, when they are not in lockstep).
  `scripts/publish-workspaces.sh --tag next|latest` refuses the wrong channel
  for the version and skips packages already on the registry, so a
  half-finished publish can be rerun (#2244).

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

- `factory init` no longer exits 2 when no GitHub token is available; it
  prints a warning and initializes `.factory/` anyway, since init never calls
  GitHub (`factory ship`/`run` still need a token). The `Publish` workflow's
  Quickstart smoke step now gets `GH_TOKEN`, like `ci.yml`'s job, so the v0.9.0
  publish no longer stops there. (#2346)
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
