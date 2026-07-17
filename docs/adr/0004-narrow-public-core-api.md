# ADR-0004: A narrow public API for `@on-par/factory-core`

- Status: Accepted
- Date: 2026-07-17

## Context

`@on-par/factory-core` is published (`publishConfig.access: public`) and is
the dependency surface for third parties who want to build on the factory
engine, not just this repo's own `cli`/`tui` packages. Its root export had
grown to include everything: concrete provider harnesses
(`ClaudeCliHarness`, `CodexCliHarness`, `OllamaAgenticHarness`, …), low-level
utils (`shellEscape`, `withGitLock`, worktree GC, coverage-ratchet parsing),
phase-internal prompt builders (`buildPlanPrompt`), local-small stepwise
helpers, eval-judging internals (`judgeSpec`, `runJudgeSamples`), and test
doubles (`StubModelExecutor`, `StubCodingHarness`, the harness contract kit)
— all flat, alongside the genuinely stable surface (config, queue, events,
models, router contract, checkers, phases, approvals, reports, logger,
types).

This makes every internal refactor a potential breaking change for anyone
depending on the package, and gives consumers no signal about which exports
are meant to be built on versus which are implementation detail that happens
to be reachable. It also means test doubles ship in the same surface as
production code paths.

## Decision

`@on-par/factory-core`'s root export (`.`) is the stable public API: config,
queue, events, models, router (failover state machine + `ModelExecutor`
contract), harness _contract_ (types + `HARNESS_CATALOG`, not concrete
harness classes), constitutions, checkers, the four phase entry points
(`buildPhase`, `checkPhase`, `planPhase`, `shipPhase`), approvals, reports,
eval (case loading, scoring/comparison, history, scoreboard — not judging
internals), usage, logger, and types.

Two new subpath exports split off everything else:

- **`@on-par/factory-core/internal`** — implementation details: concrete CLI
  harnesses, phase-internal prompt builders, local-small stepwise helpers,
  eval-judging internals, usage internals, and the utils block (worktree
  setup/teardown, locks, CI watching, worktree GC, coverage-ratchet
  parsing). No stability guarantee. Consumed only by this repo's own
  packages (`cli`, `tui`, root `scripts/*`) — never by third parties.
- **`@on-par/factory-core/testing`** — test doubles and contract kits:
  `StubModelExecutor`, `StubCodingHarness`, and the harness contract case
  generator (`codingHarnessContractCases`, `makeContractRequest`). Consumers
  who want to exercise the factory (or their own harness implementation
  against the contract) without real model CLIs import from here.

`src/test-support/` (fixture kit used by this repo's own integration tests)
stays package-private and is not re-exported from any entry point.

New exports added to `core` in the future default to `./internal` unless a
change deliberately promotes something to the public surface. Source files
do not move — only which entry file re-exports them changes; `internal.ts`
and `testing.ts` are re-export-only files alongside `index.ts`.

`packages/core/src/public-api.test.ts` pins the exact runtime export set of
all three entry points (via `Object.keys(...).sort()` equality against a
literal allowlist) and the shape of `package.json`'s `exports` map, so this
boundary is enforced by a test, not just documentation.

## Consequences

Positive:

- Third-party consumers of `@on-par/factory-core` get a documented, narrow
  surface that can evolve without breaking them; internals can be
  refactored freely.
- Test doubles are clearly separated from production code paths.
- The boundary is machine-checked (`public-api.test.ts`), so an accidental
  new root export doesn't silently widen the public API.

Negative / accepted trade-offs:

- `./internal` is still a fairly broad surface — it is not itself curated
  down to a minimal internal API in this change; that pruning is follow-up
  work.
- This repo's own packages (`cli`, `tui`, `scripts/*`) now import from two
  or three entry points instead of one, which is slightly more ceremony for
  in-repo consumers in exchange for the external guarantee.
