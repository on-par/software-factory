---
product: "todo-sf-demo"
version: 1
checkers:
  - compile
  - tests
  - lint
enforced_on: [plan, build, check]
requireTests: true
---

# Todo Sf Demo Constitution

## Purpose

todo-sf-demo is a web-based todo application — "From To-Do to Done." It lets a
user create todos, list them, mark them complete or incomplete, and delete
them. It exists as a demonstration that the software factory can build a
well-structured, fully-tested application from documentation and issues alone,
so correctness and test discipline matter more than feature breadth.

## Standards

### Architecture and stack

These are fixed by the repo's ADRs (`docs/adr/`). Work must conform; do not
introduce alternatives.

- Monorepo via **npm workspaces**; **npm** is the only package manager (one
  root `package-lock.json`, no yarn/pnpm lockfiles). (ADR 0001, 0003)
- **Node.js 24**, pinned via `.nvmrc` and `engines.node`. (ADR 0002)
- Layout: applications under `apps/` (web app at `apps/web`), shared libraries
  under `packages/`. (ADR 0004)
- The web app is **Next.js + TypeScript** with `strict: true`. (ADR 0005)
- Tests: **Vitest** (unit), **Playwright** (e2e), **V8** coverage provider.
  (ADR 0006)

### Business logic must be isolated and fully tested

This is the product's headline standard (ADR 0007).

- Business logic — domain rules, state transitions, validation, data
  transformation — lives in `packages/` (e.g. `packages/core`), not buried in
  React components, so it can be unit-tested in isolation.
- **100% coverage (lines, statements, functions, branches) on business logic**
  is a hard gate from day one, enforced via Vitest's V8 coverage thresholds set
  to 100 for the business-logic scope. A shortfall fails the build.
- "Business logic" does NOT include incidental presentation code (JSX markup,
  styling, framework glue, generated files); those are exercised by e2e and by
  unit tests where practical, but are not held to the 100% line.

### End-to-end (e2e) environment contract

The factory leases each lane a dedicated port and injects `PORT`,
`FACTORY_APP_PORT`, and `FACTORY_BASE_URL` into every build and check command
run in the worktree. E2e suites MUST boot the app on the leased port and test
the URL it actually runs on:

- `playwright.config` reads `process.env.PORT` for its `webServer` (port or
  embedded in `command`), sets `reuseExistingServer: false`, and uses a
  strict-port dev command (Next.js: `-p $PORT`) so a port mismatch fails loudly.
- `use.baseURL` derives from `process.env.FACTORY_BASE_URL`, falling back to
  `http://127.0.0.1:${process.env.PORT}` — never a hard-coded port or URL.
- The factory also injects `FACTORY_HEADLESS=1` and `PLAYWRIGHT_HEADLESS=1`:
  e2e configs MUST be headless by default and MUST NOT bake `--headed`, `--ui`,
  or similar into test scripts. Headed mode is a human opt-in outside the
  factory (`FACTORY_HEADLESS=0`), never a config default.

## Quality Gates

Work ships only when all of these pass:

- **compile** — TypeScript compiles across the workspace with no errors
  (`strict` mode).
- **tests** — the unit suite (Vitest) and, where applicable, the e2e suite
  (Playwright) pass. `requireTests: true`: a repo/slice with no runnable test
  command FAILS rather than skips.
- **lint** — the project linter passes clean.
- **Business-logic coverage is 100%** for the covered scope, enforced through
  the `tests`/coverage run (Vitest V8 thresholds). Below 100% on business logic
  is a failing gate, not a warning.

## Dispute Rules

When a worker disputes a checker failure, the boss arbitrates against the
standards above, not subjective judgment:

- A coverage failure on code that is genuinely business logic is upheld — the
  fix is more tests or refactoring the logic into a testable unit, never
  lowering the threshold or excluding the file to go green.
- A coverage complaint about genuinely incidental presentation code is
  resolved by confirming the code contains no business logic; if so, it is out
  of the 100% scope (see Standards), not a reason to weaken the gate.
- Stack deviations (a different package manager, framework, or test runner than
  the ADRs specify) are always upheld against the worker: conform to the ADRs.

## Non-Goals

- Authentication, multi-user accounts, and persistence to an external database
  are out of scope for this demo unless a specific issue introduces them.
- No deployment/hosting configuration is mandated here.
- This constitution does not cover performance, accessibility, or SEO gates for
  this demo; add them as explicit standards + checkers if the product grows.
