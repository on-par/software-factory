# Architecture

Software Factory is a TypeScript, ESM-only npm-workspaces monorepo that ships GitHub issues through a boss-worker-checker pipeline: PLAN → BUILD → CHECK → SHIP. The dependency direction is `config ← core ← cli`. `core`'s root export is the narrow public API; implementation details live behind `@on-par/factory-core/internal` and test helpers behind `@on-par/factory-core/testing` (ADR-0004).

## Packages

| Directory         | npm name                    | Published | Role                                                       |
| ----------------- | --------------------------- | --------- | ---------------------------------------------------------- |
| `core`            | `@on-par/factory-core`      | Wave-1    | Engine: router, constitutions, checkers, phases            |
| `cli`             | `@on-par/factory-cli`       | Wave-1    | The `factory` CLI (init, ship, run, triage, ...)           |
| `config`          | `@on-par/factory-config`    | Wave-1    | Shared JSON configs + product constitutions                |
| `contracts`       | `@on-par/contracts`         | Wave-1    | Shared typed seam: Issue/Epic/Story/DesignArtifact schemas |
| `tui`             | `@on-par/factory-tui`       | Wave-1    | Read-only Ink TUI for a live view of the current run       |
| `adr-kit`         | `@on-par/adr-kit`           | Wave-1    | Pure ADR kernel, zero deps                                 |
| `repo-context`    | `@on-par/repo-context`      | Wave-1    | Read-only repo reader port, zero deps                      |
| `server`          | `@on-par/factory-server`    | private   | Local HTTP server relaying the lane lifecycle bus as SSE   |
| `dashboard`       | `@on-par/factory-dashboard` | private   | Vite + React walking skeleton                              |
| `product`         | `@on-par/product`           | private   | The proposer                                               |
| `scbench-adapter` | `@on-par/scbench-adapter`   | private   | SlopCodeBench adapter                                      |

## Package dependencies

```
config       ←  core  ←  cli
contracts    ←  core  ←  tui
adr-kit      ←  core  ←  scbench-adapter (private)
repo-context ←  core
contracts    ←  server (private), dashboard (private)
adr-kit, contracts, repo-context ← product (private)
```

- **@on-par/factory-config** — Zero dependencies. Ships `defaults.ts` (typed model registry, route table, and factory defaults) and constitution markdown files.
- **@on-par/contracts** — Zero dependencies besides zod. Zod schemas + inferred types for the engineering-ready Issue/Epic/Story, Gherkin AcceptanceCriterion, and DesignArtifact shapes PLAN emits and BUILD consumes.
- **@on-par/factory-core** — The engine. Model registry, router with failover, constitution loader, checker framework, and the four pipeline phases (PLAN → BUILD → CHECK → SHIP). Imports config, contracts, adr-kit and repo-context.
- **@on-par/factory-cli** — The `factory` CLI. Imports core.
- **@on-par/factory-server** (private) — Local HTTP server. `GET /events` relays the lane lifecycle bus as SSE, with `Last-Event-ID` resume via a bounded replay ring. Depends only on `@on-par/contracts` — no auth, loopback-only.
- **@on-par/adr-kit** — Zero runtime dependencies. Pure, no-I/O ADR kernel: parses ADR markdown into a typed record, serializes it back byte-stably, models the repo's ADR convention (Nygard fallback, or inferred/reused when the repo already has ADRs), and provides next-number and index-table helpers. Imported by `@on-par/factory-core` (the ADR reader in `packages/core/src/adr/`) and by the private `packages/product` proposer (ADR reading and next-number filenames).
- **@on-par/repo-context** — Zero runtime dependencies. Defines the `RepoContextReader` port (`readFile`, `readDir`, `exists`) that every repo-reading consumer shares, plus a GitHub contents-API implementation (for the proposer, which holds only a read-only token) and an in-memory implementation (for tests, and proof the port is backend-independent). Degrades to an empty result instead of throwing on a missing path, auth failure, or rate limit. Imported by `@on-par/factory-core` (PLAN, the ADR reader, the design-smells checker and the review classifier use its filesystem reader `createFsReader`) and by the private `packages/product` proposer.
- **@on-par/factory-tui** — A read-only Ink TUI for a live view of the current Software Factory run. Imports `@on-par/factory-core`.
- **@on-par/factory-dashboard** (private) — Vite + React walking skeleton. Depends on `@on-par/contracts`.
- **@on-par/product** (private) — The proposer. Depends on adr-kit, contracts and repo-context.
- **@on-par/scbench-adapter** (private) — SlopCodeBench adapter. Depends on `@on-par/factory-core`.

For contributor rules see [AGENTS.md](../AGENTS.md); for what works today see [status.md](status.md).
