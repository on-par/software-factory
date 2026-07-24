# Constitution Template

A constitution is a written standard that defines "done right" for a product.
Every build round is tested against it. The prompt isn't instructions — it's
a standard plus a way to check it.

## Format

```markdown
---
product: <product-name>
version: 1
checkers:
  - <checker-name> # References lib/checkers/<checker-name>.sh
  - <checker-name>
enforced_on: [plan, build, check] # Which phases load this constitution
requireTests: true # FAIL (instead of SKIP) the tests checker when the repo has no verify/test command
---

# <Product> Constitution

## Purpose

<One paragraph: what this product does and who it's for>

## Standards

### <Standard Category 1>

<What "done right" means for this category. Be specific and testable.>

### <Standard Category 2>

<...>

### End-to-end (e2e) environment contract

The factory leases each lane a dedicated port and injects `PORT`,
`FACTORY_APP_PORT`, and `FACTORY_BASE_URL` into every build and check
command run in the worktree. E2e suites MUST boot the app on the leased
port and test the URL it actually runs on:

- `playwright.config` reads `process.env.PORT` for its `webServer`
  (port or embedded in `command`), sets `reuseExistingServer: false`,
  and uses a strict-port dev command (Vite: `--strictPort`;
  Next.js: `-p $PORT`) so a port mismatch fails loudly.
- `use.baseURL` derives from `process.env.FACTORY_BASE_URL`, falling
  back to `http://127.0.0.1:${process.env.PORT}` — never a hard-coded
  port or URL.
- The factory also injects `FACTORY_HEADLESS=1` and `PLAYWRIGHT_HEADLESS=1`
  into every factory-managed build and check command: e2e configs MUST be
  headless by default (`headless: true`, or omitted — headless is
  Playwright's default) and MUST NOT bake `--headed`, `--ui`, or
  `cypress open` into test scripts. Headed mode is an explicit human
  opt-in run outside the factory (or `FACTORY_HEADLESS=0`), never a
  config default. The CHECK phase warns on configs that force headed mode.
- The contract (ports and headless) is plain environment variables, so
  the same rules apply to any e2e tool (Cypress, WebdriverIO, curl smoke
  tests); Playwright is the documented reference, not a dependency.

## Quality Gates

<Which checks must pass before work ships. References checkers in lib/checkers/.>

## Dispute Rules

<How the boss should arbitrate when a worker disputes a checker failure.
Reference the standards above, not subjective judgment.>

## Non-Goals

<What this constitution does NOT cover — explicitly out of scope.>
```

## Writing a Constitution

1. **Name what "done right" means** — concrete, testable criteria, not vibes.
2. **Map each standard to a checker** — every standard should be machine-verifiable.
3. **Define dispute rules** — when a worker says "the checker is wrong," the boss needs a principled way to decide. Reference the standards, not opinion.
4. **List non-goals** — prevents scope creep and false failures from checkers testing things that don't matter for this product.

## How It's Used

- **PLAN phase**: The boss reads the constitution before writing the spec. The spec must satisfy every standard.
- **BUILD phase**: The worker receives the constitution alongside the spec. It's the standard the work will be checked against.
- **CHECK phase**: Each checker reads the relevant standards section and verifies the output against it — not against the worker's self-report.
- **DISPUTE**: When a worker escalates a checker failure, the boss re-reads the constitution to decide. Standards outrank both worker and checker.
