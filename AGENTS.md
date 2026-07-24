# AGENTS.md

Context for AI coding agents working in this repository. Read this before starting any task.

## Project overview

**Software Factory** (`@on-par/software-factory`, v2.0.0) is a TypeScript/Node.js monorepo that implements a multi-agent "software factory" — it ships verified GitHub issues autonomously through a **boss-worker-checker** orchestration pattern (PLAN → BUILD → CHECK → SHIP). Its distinguishing ideas are: **config-driven multi-provider model routing** with automatic failover (free local Ollama models first, cloud models such as Claude and Codex/GPT as failover, ranked per task tier), per-product **constitutions** (a written "standard + how to verify it" injected into every phase), and an independent **checker framework** with a rework loop. The engine is UI-less and packaged so a CLI (and, eventually, a server) can consume it.

## Repository layout

```
software-factory/
├── packages/
│   ├── config/   @on-par/factory-config  — Zero-dep. Ships models.json, routes.json,
│   │                                        factory.json, and constitution markdown.
│   ├── core/     @on-par/factory-core     — The engine (imports config).
│   ├── cli/      @on-par/factory-cli       — The `factory` CLI (imports core).
│   ├── dashboard/ @on-par/factory-dashboard — Vite + React + Tailwind dashboard (walking skeleton, private).
│   └── server/   @on-par/factory-server    — Phase-2 SaaS server STUB. createServer()
│                                             throws; marked private, never published.
├── tools/
│   └── lint/     @on-par/factory-lint      — Lint toolchain workspace. Carries a nested
│                                             TypeScript 5.x so typescript-eslint can run
│                                             next to the root's native TypeScript 7 compiler.
├── scripts/      Root tooling: verify.sh, eval.ts, eval-history.ts,
│                 regression-issue.ts, local-small-scoreboard.ts,
│                 coverage-ratchet.ts
├── evals/        Golden eval cases (evals/golden/*.md) + baseline.json + README
├── docs/         Research notes (docs/research/*) + ADRs (docs/adr/ — see its README)
├── tsconfig.base.json / tsconfig.json      Composite project references
└── package.json  npm workspaces root
```

Dependency direction: `config ← core ← cli` and `config ← core ← server`.

### What lives in `packages/core/src`

- `router/` — `ModelRouter` failover state machine + CLI executor
- `models/` — `ModelRegistry` (reads `models.json`)
- `harness/` — provider adapters: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`, plus a `stub` and a contract test suite
- `phases/` — the four pipeline phases (`plan`, `build`, `check`, `ship`) plus integration tests (`pipeline.integration.test.ts`, `pipeline.concurrent.integration.test.ts`)
- `checkers/` — the checker framework (compile/tests/lint/links/accessibility + agent-based custom checkers)
- `constitutions/` — constitution loader
- `environment/` — port-lease registry for parallel lanes (`.factory/ports.json`) + `leaseEnv()`/`laneEnv()`, the `PORT`/`FACTORY_APP_PORT`/`FACTORY_BASE_URL` + `FACTORY_HEADLESS`/`PLAYWRIGHT_HEADLESS` contract injected into build agents and all checker commands
- `logger/` — structured leveled logger (`createLogger`) over the `.factory/events.ndjson` sink (ADR-0002)
- `eval/` — the eval harness (runner, judge, scoring, golden loader, baseline/trend/regression reports)
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
- **Lint:** ESLint flat config (`eslint.config.mjs` at root re-exporting `tools/lint/eslint.config.mjs`), run via `npm run lint` with `--max-warnings 0`.

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
bash scripts/verify.sh
```

Build, typecheck, lint, test (with coverage thresholds), and the stub eval must **all** pass — this is exactly what CI enforces. Do not commit with a failing or reduced coverage gate.
