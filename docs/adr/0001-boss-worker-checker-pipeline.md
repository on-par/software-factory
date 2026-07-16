# ADR-0001: Boss–worker–checker pipeline with per-issue build routing

- Status: Accepted
- Date: 2026-07-16

## Context

Shipping GitHub issues autonomously with one monolithic agent conflates three
different jobs that have very different cost and judgment profiles:

- Deciding **what** to build — judgment-heavy, needs a strong model to read the
  issue, explore the repo, and commit to a scope.
- **Building** it — once a spec is frozen, mostly mechanical; cheap models
  suffice.
- **Verifying** it — must be independent of the builder, or the builder is
  effectively grading its own homework.

Model costs vary roughly 100x across tiers, and a single agent's self-reported
success is not a reliable signal that the work is actually correct.

## Decision

The pipeline is four sequential phases per issue — **PLAN → BUILD → CHECK →
SHIP** — implemented in `packages/core/src/phases/` (`plan.ts`, `build.ts`,
`check.ts`, `ship.ts`), with each phase run in an isolated per-issue worktree.

Three model tiers are declared in `packages/config/src/models.json`
(`tier: boss | worker | checker`, plus `boss_fallback` / `worker_fallback`) and
mapped to task types in `packages/config/src/routes.json`. Config is the
source of truth for routing; core never hard-codes model lists.

- **Boss (PLAN)** — a strong model reads the issue, explores the repo, and
  freezes a spec at `.factory/plans/issue-N.md`. Crucially, the boss also
  makes the per-issue *build-route decision*, recorded as `route: codex |
  claude` frontmatter on the spec: `route: codex` when implementation from the
  frozen spec is bounded and mechanical, `route: claude` when the work needs
  design/UX/architecture judgment (see the `build_codex` vs `build_claude`
  routes in `routes.json`). This is where "which model builds it" is
  decided — per issue, not globally.
- **Worker (BUILD)** — a cheaper model implements the frozen spec verbatim.
  The spec is frozen precisely so a weak worker cannot drift scope.
- **Checker (CHECK)** — independent checkers
  (`packages/core/src/checkers/` — compile, tests, lint, links,
  accessibility, plus constitution-driven custom checkers) verify the output
  against the product constitution, not the worker's self-report. Failures
  trigger a bounded rework loop (`check.ts`: rework rounds up to a max, then
  the issue is parked rather than force-shipped).
- **SHIP** — PR review and merge, serialized across parallel lanes.

Every phase gets the product constitution (standard + how to verify it)
injected into its prompt (`packages/core/src/constitutions/`).

## Consequences

Positive:

- Expensive judgment is paid once per issue (PLAN) instead of continuously.
- Mechanical work goes to cheap/free models with automatic failover.
- Verification is independent, so a lying or sloppy worker gets caught by
  CHECK, not by the user.
- Lanes parallelize because each phase is stateless between issues.

Negative / accepted trade-offs:

- A frozen spec can go stale if main moves during the lane's lifetime
  (worktree drift).
- BUILD quality is capped by PLAN quality — a bad spec produces a faithful
  implementation of the wrong thing.
- The rework loop adds latency and can still park an issue unresolved.
- More moving parts (router, tiers, routes config) than a single-agent
  design.

Follow-on decisions this creates (candidates for future ADRs, not written
here): multi-provider model routing with failover, the coverage-ratchet
policy, the serialized merge train.
