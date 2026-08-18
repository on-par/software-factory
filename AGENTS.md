# AGENTS.md

Context for AI coding agents working in this repository. Read this before starting any task.

## Project overview

**Software Factory** (`@on-par/software-factory`, v2.0.0) is a TypeScript/Node.js monorepo that implements a multi-agent "software factory" — it ships verified GitHub issues autonomously through a **boss-worker-checker** orchestration pattern (PLAN → BUILD → CHECK → SHIP). Its distinguishing ideas are: **config-driven multi-provider model routing** with automatic failover (free local Ollama models first, cloud models such as Claude and Codex/GPT as failover, ranked per task tier), per-product **constitutions** (a written "standard + how to verify it" injected into every phase), and an independent **checker framework** with a rework loop. The engine is UI-less and packaged so a CLI (and, eventually, a server) can consume it.

## Repository layout

```
software-factory/
├── packages/
│   ├── adr-kit/  @on-par/adr-kit           — Pure ADR kernel: parse/serialize/template/
│   │                                        numbering, zero deps, no I/O.
│   ├── contracts/ @on-par/contracts        — Shared typed seam: zod schemas + inferred
│   │                                        types for Issue/Epic/Story/DesignArtifact.
│   ├── repo-context/ @on-par/repo-context  — Read-only repo reader port: GitHub
│   │                                        contents-API and in-memory impls, zero deps.
│   ├── config/   @on-par/factory-config  — Zero-dep. Ships models.json, routes.json,
│   │                                        factory.json, and constitution markdown.
│   ├── core/     @on-par/factory-core     — The engine (imports config).
│   ├── cli/      @on-par/factory-cli       — The `factory` CLI (imports core).
│   ├── dashboard/ @on-par/factory-dashboard — Vite + React + Tailwind dashboard (walking skeleton, private).
│   ├── product/  @on-par/product           — Product (proposer) app: brain-dump →
│   │                                        engineering-ready issues. Read-only, private.
│   └── server/   @on-par/factory-server    — Phase-2 SaaS server STUB. createServer()
│                                             throws; marked private, never published.
├── scripts/      Root tooling: verify.sh, eval.ts, eval-history.ts,
│                 regression-issue.ts, local-small-scoreboard.ts,
│                 coverage-ratchet.ts
├── evals/        Golden eval cases (evals/golden/*.md) + baseline.json + README
├── docs/         Research notes (docs/research/*) + ADRs (docs/adr/ — see its README)
├── tsconfig.base.json / tsconfig.json      Composite project references
└── package.json  npm workspaces root
```

Dependency direction: `contracts ← core ← cli`, `config ← core ← cli`, `config ← core ← server`,
`adr-kit ← product`, `adr-kit ← core`, `repo-context ← core`, and `repo-context ← product` — the ADR writer and
readiness-conformance checker named in epic #464 consume them in later stories.

### What lives in `packages/core/src`

- `router/` — `ModelRouter` failover state machine + CLI executor
- `models/` — `ModelRegistry` (reads `models.json`)
- `harness/` — provider adapters: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`, plus a `stub` and a contract test suite
- `phases/` — the four pipeline phases (`plan`, `build`, `check`, `ship`) plus integration tests (`pipeline.integration.test.ts`, `pipeline.concurrent.integration.test.ts`)
- `checkers/` — the checker framework (compile/tests/lint/links/accessibility + agent-based custom checkers)
- `constitutions/` — constitution loader
- `adr/` — reads the checkout's `docs/adr` through a `RepoContextReader` and renders Accepted ADRs as PLAN constraints
- `environment/` — port-lease registry for parallel lanes (`.factory/ports.json`) + `leaseEnv()`/`laneEnv()`, the `PORT`/`FACTORY_APP_PORT`/`FACTORY_BASE_URL` + `FACTORY_HEADLESS`/`PLAYWRIGHT_HEADLESS` contract injected into build agents and all checker commands
- `logger/` — structured leveled logger (`createLogger`) over the `.factory/events.ndjson` sink (ADR-0002)
- `eval/` — the eval harness (runner, judge, scoring, golden loader, baseline/trend/regression reports)
- `sim/` — headless simulator harness (fake model/octokit, throwaway git workspace, jitter injection, Monte Carlo runner), and regression fixtures for known production faults
- `usage/`, `reports/`, `local-small/`, `utils/` (incl. `lock.ts`, `ci-watch.ts`), `config/`, `types/`

## Key commands

Run from the repo root unless noted. Node.js **≥ 20** required.

| Task                           | Command                                  |
| ------------------------------ | ---------------------------------------- |
| Install (clean, CI-style)      | `npm ci`                                 |
| Install (dev)                  | `npm install`                            |
| Build all packages             | `npm run build` (`tsc -b`)               |
| Typecheck                      | `npm run typecheck`                      |
| Lint                           | `npm run lint`                           |
| Format all files               | `npm run format`                         |
| Format check                   | `npm run format:check`                   |
| Dead code / unused deps        | `npm run knip`                           |
| Test with coverage             | `npm run test` (`vitest run --coverage`) |
| Coverage ratchet drift check   | `npm run coverage-ratchet`               |
| Eval (deterministic stub)      | `npm run eval -- --stub`                 |
| Eval (full harness)            | `npm run eval`                           |
| Simulator Monte Carlo batch    | `npm run sim-monte-carlo -- --runs 20`   |
| Full verify (all of the above) | `bash scripts/verify.sh`                 |

`scripts/verify.sh` runs, in order: `npm ci` → `npm run format:check` → `npm run build` → `npm run typecheck` → `npm run lint` → `npm run knip` → `npm run test` → `npm run coverage-ratchet` → `npm run eval -- --stub`. This mirrors the CI workflow in `.github/workflows/ci.yml`.

## Conventions

- **Language:** TypeScript, strict mode, ESM only — every `package.json` sets `"type": "module"`. Use `import`/`export`, `.js` extensions on relative imports where required by NodeNext resolution.
- **Runtime:** Node.js ≥ 20 (`engines.node: ">=20.0.0"`).
- **Monorepo:** npm workspaces (`packages/*`) with TypeScript composite project references (`tsc -b`). Cross-package imports use the published names (`@on-par/factory-core`, `@on-par/factory-config`), not relative paths across package boundaries.
- **Dependencies:** keep `config` zero-dependency. Core depends on `execa`, `@octokit/rest`, `gray-matter`, `zod`.
- **Config as source of truth:** model routing lives in `packages/config/src/models.json` + `routes.json`; do not hard-code model lists in `core`.
- **`core`'s root export is the narrow public API** — implementation details live behind `@on-par/factory-core/internal`, test helpers behind `@on-par/factory-core/testing` (ADR-0004).
- **The `server` package is a stub** — do not build features on it; `createServer()` intentionally throws.
- **Lint:** Oxlint with the TS 7-native `oxlint-tsgolint` type-aware backend. Configuration lives in `.oxlintrc.json`; run `npm run lint`, which denies warnings.

## Testing

- Test runner is **Vitest**. Tests are `*.test.ts` files **colocated** next to the source they cover in each package's `src/` tree (e.g. `packages/core/src/router/index.test.ts`).
- `npm run test` at the root runs all workspace tests in one pass and aggregates coverage (config in `vitest.config.ts`, which globs `packages/*/src/**/*.test.ts`).
- **Coverage gate:** v8 thresholds enforced by Vitest — lines 94, functions 91, branches 85, statements 94 globally. Each package (`config`, `core`, `cli`, `dashboard`) also has its own ratcheting thresholds in `vitest.config.ts`, so a per-package regression fails the build even if the aggregate stays above the global floor. The ratchet is self-enforcing: `npm run coverage-ratchet` (run by `verify.sh` and CI after tests) fails when measured coverage exceeds any threshold by more than 2 points, telling you to raise the thresholds in the same PR. Never lower them. `packages/core/src/types/**` is excluded from coverage.
- **TDD is expected:** write or update the colocated `*.test.ts` alongside any source change. Integration tests for the pipeline live under `packages/core/src/phases/`.
- **Evals:** golden cases live in `evals/golden/*.md` with `evals/baseline.json`. The deterministic stub subset (`npm run eval -- --stub`) runs in CI on every PR; the full LLM-judge mode runs locally/nightly.
- `packages/dashboard` renders via Vite; its component tests are `*.test.tsx` files colocated in `src/` (e.g. `packages/dashboard/src/App.test.tsx`).

## Known agent traps

- **Do not "fix" the `test` script in `packages/core/package.json`.** It is intentionally `"test": "vitest run"`. Codex-style agents repeatedly rewrite it to work around a pre-existing vitest quirk when running tests from inside the package — that change is always out of scope and must be reverted. Run tests from the **repo root** with `npm run test` (or `bash scripts/verify.sh`), which is where coverage is configured and aggregated.

## Before committing

Run the full verification gate and make sure everything is green:

```bash
bash scripts/verify.sh --no-e2e
```

Build, typecheck, lint, test (with coverage thresholds), and the stub eval must **all** pass — this is what CI enforces on every PR. Use `--no-e2e` for your local loop: the bare (no-flag) path also runs the pipeline integration/simulation tests, which have a known intermittent multi-hour deadlock (#739) — `--no-e2e` is the fast, reliable path and is what CI's own quick checks and the CHECK phase both use. Real CI still runs the full suite including integration tests on the PR, so this doesn't skip anything that matters getting merged. Do not commit with a failing or reduced coverage gate.

## Merge policy: main must always be green

`main` must never carry a genuinely failing test, type error, or lint violation. Concretely:

- **Never use `gh pr merge --admin` (or any merge that bypasses required status checks) to get past a check that is actually `FAILURE`.** Admin/bypass merges exist only for two legitimate cases: (1) the factory's own auto-merge, which bypasses the _review-approval_ requirement a bot can't obtain — but its `watchCi()` gate already refuses to merge unless CI reported a real `success`, never on failure or an unresolved/hung outcome (see `packages/cli/src/cli/index.ts`, `waitForMerge`); and (2) a human confirming a required check is _hung/stuck_, not failed (e.g. the #739 CI deadlock), after running an equivalent verification pass locally (`bash scripts/verify.sh --no-e2e` green, plus targeted checks for anything the fast path skips) — and saying so explicitly in the merge/PR comment.
- If you bypass a check for reason (2), that is a workaround for a known infra bug, not a norm. The actual fix is closing that bug (#739 / #755 — moving the deadlock-prone integration tests off the required check and adding a subprocess timeout), which removes the need for bypass merges entirely.
- If a `main`-red test is discovered (e.g. it slipped through during a CI-hang period), fix it immediately as the top-priority task — a red `main` blocks everyone and every future PR's diff against it.
