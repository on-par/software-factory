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
│   ├── cli/      @on-par/factory-cli       — The `factory` CLI (imports core + config).
│   ├── dashboard/ @on-par/factory-dashboard — Vite + React + Tailwind dashboard (walking skeleton, private).
│   └── server/   @on-par/factory-server    — Phase-2 SaaS server STUB. createServer()
│                                             throws; marked private, never published.
├── scripts/      Root tooling: verify.sh, eval.ts, eval-history.ts,
│                 regression-issue.ts, local-small-scoreboard.ts
├── evals/        Golden eval cases (evals/golden/*.md) + baseline.json + README
├── docs/         Research notes (docs/research/*)
├── legacy/       Original bash `factory` implementation, preserved for reference only
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
- `eval/` — the eval harness (runner, judge, scoring, golden loader, baseline/trend/regression reports)
- `usage/`, `reports/`, `local-small/`, `utils/` (incl. `lock.ts`, `ci-watch.ts`), `config/`, `types/`

## Key commands

Run from the repo root unless noted. Node.js **≥ 20** required.

| Task | Command |
|------|---------|
| Install (clean, CI-style) | `npm ci` |
| Install (dev) | `npm install` |
| Build all packages | `npm run build` (`tsc -b`) |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Test with coverage | `npm run test` (`vitest run --coverage`) |
| Eval (deterministic stub) | `npm run eval -- --stub` |
| Eval (full harness) | `npm run eval` |
| Full verify (all of the above) | `bash scripts/verify.sh` |

`scripts/verify.sh` runs, in order: `npm ci` → `npm run build` → `npm run typecheck` → `npm run lint` → `npm run test` → `npm run eval -- --stub`. This mirrors the CI workflow in `.github/workflows/ci.yml`.

## Conventions

- **Language:** TypeScript, strict mode, ESM only — every `package.json` sets `"type": "module"`. Use `import`/`export`, `.js` extensions on relative imports where required by NodeNext resolution.
- **Runtime:** Node.js ≥ 20 (`engines.node: ">=20.0.0"`).
- **Monorepo:** npm workspaces (`packages/*`) with TypeScript composite project references (`tsc -b`). Cross-package imports use the published names (`@on-par/factory-core`, `@on-par/factory-config`), not relative paths across package boundaries.
- **Dependencies:** keep `config` zero-dependency. Core depends on `execa`, `@octokit/rest`, `gray-matter`, `zod`.
- **Config as source of truth:** model routing lives in `packages/config/src/models.json` + `routes.json`; do not hard-code model lists in `core`.
- **The `server` package is a stub** — do not build features on it; `createServer()` intentionally throws.

## Testing

- Test runner is **Vitest**. Tests are `*.test.ts` files **colocated** next to the source they cover in each package's `src/` tree (e.g. `packages/core/src/router/index.test.ts`).
- `npm run test` at the root runs all workspace tests in one pass and aggregates coverage (config in `vitest.config.ts`, which globs `packages/*/src/**/*.test.ts`).
- **Coverage gate:** v8 thresholds enforced by Vitest — lines 74, functions 76, branches 80, statements 74. The build fails if coverage drops below these. They ratchet upward, so add tests with your code rather than lowering the floor. `packages/server/**` and `packages/core/src/types/**` are excluded from coverage.
- **TDD is expected:** write or update the colocated `*.test.ts` alongside any source change. Integration tests for the pipeline live under `packages/core/src/phases/`.
- **Evals:** golden cases live in `evals/golden/*.md` with `evals/baseline.json`. The deterministic stub subset (`npm run eval -- --stub`) runs in CI on every PR; the full LLM-judge mode runs locally/nightly.
- `packages/dashboard` renders via Vite; its component tests are `*.test.tsx` files colocated in `src/` (e.g. `packages/dashboard/src/App.test.tsx`).

## Before committing

Run the full verification gate and make sure everything is green:

```bash
bash scripts/verify.sh
```

Build, typecheck, lint, test (with coverage thresholds), and the stub eval must **all** pass — this is exactly what CI enforces. Do not commit with a failing or reduced coverage gate.
