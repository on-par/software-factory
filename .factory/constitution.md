---
product: software-factory
version: 1
checkers: [] # empty = every built-in checker
enforced_on: [plan, build, check]
requireTests: true # FAIL (instead of SKIP) the tests checker when no verify/test command is found
---

# Software Factory Constitution

## Purpose

Software Factory ships a repository's GitHub issues autonomously through a boss-worker-checker
pipeline: PLAN → BUILD → CHECK → SHIP. It is a strict-TypeScript, ESM-only npm workspaces
monorepo published as the lockstep `@on-par/*` packages: `config` (typed defaults and
constitutions), `core` (the UI-less engine) and `cli` (the `factory` command), plus the
dashboard, TUI, server and support packages. Its users are operators who point the factory at
their own repos, locally or through the reusable `factory-run.yml` GitHub Actions workflow.
The factory builds itself, so a change here must keep the factory able to ship the next change.

## Standards

### Verify gate

- `bash scripts/verify.sh --no-e2e` passes from the repo root: format check, build, ADR index,
  type-check, oxlint with `--deny-warnings`, knip, vitest with coverage, the test budget and the
  stub evals.
- Coverage thresholds in `vitest.config.ts` never go down. When the coverage ratchet reports a
  rise, the same change raises the threshold.
- No test is skipped, disabled or deleted to get green. Lint rules are not switched off inline
  to silence a finding the change introduced.

### Tests

- Every source change writes or updates the colocated `*.test.ts` next to the file it changes.
- New behavior is covered by a test that fails without the change. Bug fixes add a regression
  test that reproduces the reported failure.
- Tests run from the repo root (`npm run test`). Do not edit `packages/core/package.json`'s
  `test` script; it is intentionally `vitest run`.
- Shell scripts under `scripts/` that have a `*.test.sh` keep it passing and extend it when
  their behavior changes.

### Architecture

- Dependency direction is `config ← core ← cli`. `packages/config` stays zero-dependency.
- Model ids and routing live in `packages/config/src/defaults.ts`, never hard-coded in `core`.
- `core`'s root export is the narrow public API. Implementation details go behind
  `@on-par/factory-core/internal` and test helpers behind `@on-par/factory-core/testing`
  (ADR-0004).
- Import across packages by published name (`@on-par/factory-core`), never by a relative path
  across a package boundary. Relative imports use `.js` extensions.
- A significant design decision is recorded as an ADR in `docs/adr/` in the same change.
- Code uses the domain terms in `CONTEXT.md` (lane, run, claim, lease, park, rework round,
  trust tier, ...) with the meanings defined there.

### Docs and release hygiene

- A user- or ops-visible change adds a one-line entry under `## Unreleased` in `CHANGELOG.md`
  (`### Added`, `### Changed` or `### Fixed`) ending in the issue number, and updates the
  docs users read (`README.md`, `docs/status.md`, `docs/agents.md`, `docs/models.md`,
  `docs/ops/`, `docs/runbooks/`) in the same change.
- `version` in any `package.json` is never hand-edited; the publish job owns it.
- `docs/config.example.yaml` is generated (`npm run config-example`), never edited by hand.

### Safety

- No secrets, tokens, credentials or machine-local paths are committed, logged or written into
  PR bodies, issue comments or run artifacts.
- Shell built from inputs (issue text, labels, config, workflow inputs) is never `eval`-ed or
  interpolated; pass argument lists and escape with `shellEscape`.
- The factory never weakens the guardrails it enforces on other repos: branch protections,
  required checks, trust tiers, risk rules and run locks.
- GitHub Actions workflows take inputs through step `env`, never `${{ inputs.* }}` inside
  `run:`, and pin third-party actions and the factory CLI by version.

### Scope

- The diff does what the issue's acceptance criteria say, and nothing unrelated: no drive-by
  refactors, renames or reformatting of untouched files.
- No debug leftovers (`console.log` probes, commented-out code, `.only` tests, TODOs without an
  issue number).

### End-to-end (e2e) environment contract

The factory leases each lane a dedicated port and injects `PORT`, `FACTORY_APP_PORT` and
`FACTORY_BASE_URL` into every build and check command run in the worktree. Any e2e or smoke
suite added to this repo (for example for the dashboard or server) boots the app on the leased
port and tests the URL it actually runs on:

- `playwright.config` reads `process.env.PORT` for its `webServer`, sets
  `reuseExistingServer: false` and uses a strict-port dev command (Vite: `--strictPort`), so a
  port mismatch fails loudly.
- `use.baseURL` derives from `process.env.FACTORY_BASE_URL`, falling back to
  `http://127.0.0.1:${process.env.PORT}`; never a hard-coded port or URL.
- The factory injects `FACTORY_HEADLESS=1` and `PLAYWRIGHT_HEADLESS=1`. E2e configs are
  headless by default and never bake `--headed`, `--ui` or `cypress open` into test scripts.

## Quality Gates

Every built-in checker runs (`checkers: []`). A change ships only when all of them pass:

1. `worker_output`: the worker produced a real diff against the base.
2. `compile`: `npm run build` and `npm run typecheck` pass.
3. `tests`: the verify/test command passes. With `requireTests: true` a missing test command
   is a FAIL, not a SKIP.
4. `lint`: oxlint and `prettier --check` report no new findings on the change.
5. `links` and `accessibility`: generated HTML (dashboard, reports) has resolving links and
   passes the basic accessibility checks.
6. `design_smells`: the model-judged review finds no design smell a reviewer would flag
   against the Standards above.

After SHIP opens the PR, the required `ci` check on GitHub must be green before it merges.
`main` is always green; a genuinely failing required check is never bypassed.

## Dispute Rules

When the worker disputes a checker finding, the boss decides against the issue's acceptance
criteria and the Standards above, in this order:

1. A failing build, type-check, test, lint or coverage threshold is never waived. The worker
   fixes the code, not the gate.
2. A failure that also fails on the base SHA with no change applied is an environment failure,
   not the worker's; the boss records it and does not count it against the change.
3. A `design_smells` finding that contradicts the acceptance criteria, an ADR or an existing
   pattern in the same package is dismissed with that reference. Otherwise the worker fixes it.
4. A finding asking for work outside the issue's scope is dismissed and, if it is real, filed
   as a new issue instead of growing the diff.

## Non-Goals

- Live provider calls in tests. Unit and integration tests use fakes and stubs; full LLM-judge
  evals (`npm run eval` without `--stub`) are run by hand, not by CHECK.
- Releases. Tagging, version bumps and npm publishing belong to the release process in
  `docs/ops/docs-and-changelog.md`, not to an issue's change.
- Merging policy for third-party repos. This constitution governs changes to Software Factory
  itself; consumer repos bring their own `.factory/constitution.md`.
