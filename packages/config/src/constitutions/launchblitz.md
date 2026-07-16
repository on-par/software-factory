---
product: 'launchblitz'
version: 1
checkers:
  - compile
  - tests
  - lint
enforced_on: [plan, build, check]
---

# Launchblitz Constitution

## Purpose

LaunchBlitz takes a founder from a raw business idea to a launch-ready
handoff in one guided session. A **Build** is a persisted founder project
worked through ordered **Stages** (idea capture, market validation, customer
avatar, positioning, copy deck, brand inputs, Lovable export, launch kit)
across one or more **Sessions**, yielding a **Launch packet**. Stack: Next.js
(App Router) + Turborepo monorepo, Clerk auth, Stripe billing, Drizzle ORM on
Supabase/Postgres, Tailwind CSS v4, Playwright e2e. See `CONTEXT.md` for the
full product vocabulary — use its terms exactly (e.g. "Build" not "Project",
"Launch packet" not "Build packet").

## Standards

### Speed-to-MVP, with coverage trending up

- The goal right now is shipping working stages toward a payable MVP — do
  not block an issue on the repo already having full coverage, and don't
  demand exhaustive branch coverage of every edge case just to ship one
  stage.
- That said, new/changed code should leave the repo's coverage no worse than
  it found it, and ideally a little better: cover the behavior the issue
  actually adds before calling it done. The bar is "does this PR's own
  code have real tests," not "does the whole repo already meet a coverage
  floor."
- Prefer the smallest correct implementation that satisfies the issue's
  acceptance criteria over a more general or "future-proof" one.

### Test-Driven, Pragmatically

- New business logic (API routes, repository/db functions, validation)
  should ship with a colocated test: `foo.ts` → `foo.test.ts`, following the
  existing pattern (`route.test.ts`, `repository.test.ts`, `validation.test.ts`).
- Trivial UI composition (a page that just wires components together with no
  branching logic) does not need a dedicated unit test — cover it via e2e
  instead if it's a critical path.
- No meaningless tests: no `expect(true).toBe(true)`, no tests that assert a
  function exists without exercising real behavior.

### E2e Tests

- Live in the top-level `e2e/` directory (established pattern — this product
  spans `apps/web` + `packages/*`, so top-level is correct, not a colocation
  violation).
- Must run headless, with `forbidOnly: !!process.env.CI` and CI-appropriate
  retries/workers, per Playwright config already in place.
- Reserve e2e for critical, cross-cutting flows (auth → build → session →
  packet). Don't e2e-test what a unit/integration test already covers.

### Code Quality

- TypeScript strict mode — no `any` without a comment explaining why.
- Tailwind for all styling — no new inline `<style>` blocks or hand-rolled
  CSS files outside `apps/web/app/globals.css` tokens. If a one-off vanilla
  CSS file shows up, flag it for conversion rather than extending it.
- Secrets never committed. Real values live in `.env.local` (gitignored) or
  CI/Vercel secret stores; `.env.example` holds placeholders only
  (`sk_test_replace_me`-style). This is already enforced by `.gitignore` and
  the `pr-verify.yml` workflow — do not weaken it.

### Architecture

- Business logic (repository functions, validation, Stripe/Clerk
  integration) lives in `packages/*`, not inline in route handlers or page
  components — route handlers stay thin and delegate.
- Drizzle schema changes go through migrations in `packages/db/drizzle/`,
  never hand-edited against a live database.

## Quality Gates

1. `compile` — `tsc --noEmit` (or the Turborepo `build` task) passes with no
   errors across affected packages.
2. `lint` — no lint errors.
3. `tests` — unit/integration tests pass (`npm test` / Turborepo `test`
   task). This repo is public, so hosted GitHub Actions CI is unmetered —
   CI going green is required before auto-merge, same as the other two
   on-par repos.

## Dispute Rules

- If a checker flags a missing test on a genuinely trivial composition file
  (per the UI exception above), the worker may argue it and the boss
  arbitrates against the Standards section — not subjective judgment.
- A PR that drops the repo's overall coverage percentage is a disputable
  finding the checker should raise (not a hard block by itself) — the
  worker should add tests for its own new code rather than dispute it away.
  A missing test for real business logic is always a violation, coverage
  trend aside.

## Non-Goals

- No hard repo-wide coverage floor/gate (contrast with sound-buddy's
  ratchet-to-current-floor approach) — coverage should trend up per PR,
  not be enforced as a blocking threshold before that's earned.
- Visual/design polish (logo, marketing copy, brand refinement) is out of
  scope for this constitution — track it as its own issue, not a quality
  gate on feature PRs.
