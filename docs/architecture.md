# Architecture

Software Factory is a TypeScript, ESM-only npm-workspaces monorepo that ships GitHub issues through a boss-worker-checker pipeline: PLAN → BUILD → CHECK → SHIP. The dependency direction is `config ← core ← cli`. `core`'s root export is the narrow public API; implementation details live behind `@on-par/factory-core/internal` and test helpers behind `@on-par/factory-core/testing` (ADR-0004).

## Packages

| Directory      | npm name                 | Published | Role                                                       |
| -------------- | ------------------------ | --------- | ---------------------------------------------------------- |
| `core`         | `@on-par/factory-core`   | Wave-1    | Engine: router, constitutions, checkers, phases            |
| `cli`          | `@on-par/factory-cli`    | Wave-1    | The `factory` CLI (init, ship, run, triage, ...)           |
| `config`       | `@on-par/factory-config` | Wave-1    | Shared JSON configs + product constitutions                |
| `contracts`    | `@on-par/contracts`      | Wave-1    | Shared typed seam: Issue/Epic/Story/DesignArtifact schemas |
| `tui`          | `@on-par/factory-tui`    | Wave-1    | Read-only Ink TUI for a live view of the current run       |
| `adr-kit`      | `@on-par/adr-kit`        | Wave-1    | Pure ADR kernel, zero deps                                 |
| `repo-context` | `@on-par/repo-context`   | Wave-1    | Read-only repo reader port, zero deps                      |

## Package dependencies

```
config       ←  core  ←  cli
contracts    ←  core  ←  tui  ←  cli
adr-kit      ←  core
repo-context ←  core
```

## Dependency edges

One line per internal `@on-par/*` dependency in a package.json (dependencies, devDependencies, peerDependencies), by directory name. `scripts/agents-layout.test.ts` checks this list. `adr-kit`, `config`, `contracts` and `repo-context` have no internal edges.

- `cli` → `config`
- `cli` → `core`
- `cli` → `tui`
- `core` → `adr-kit`
- `core` → `config`
- `core` → `contracts`
- `core` → `repo-context`
- `tui` → `core`

- **@on-par/factory-config** — Zero dependencies. Ships `defaults.ts` (typed model registry, route table, and factory defaults) and constitution markdown files.
- **@on-par/contracts** — Zero dependencies besides zod. Zod schemas + inferred types for the engineering-ready Issue/Epic/Story, Gherkin AcceptanceCriterion, and DesignArtifact shapes PLAN emits and BUILD consumes.
- **@on-par/factory-core** — The engine. Model registry, router with failover, constitution loader, checker framework, and the four pipeline phases (PLAN → BUILD → CHECK → SHIP). Imports config, contracts, adr-kit and repo-context.
- **@on-par/factory-cli** — The `factory` CLI. Imports config, core and tui.
- **@on-par/adr-kit** — Zero runtime dependencies. Pure, no-I/O ADR kernel: parses ADR markdown into a typed record, serializes it back byte-stably, models the repo's ADR convention (Nygard fallback, or inferred/reused when the repo already has ADRs), and provides next-number and index-table helpers. Imported by `@on-par/factory-core` (the ADR reader in `packages/core/src/adr/`).
- **@on-par/repo-context** — Zero runtime dependencies. Defines the `RepoContextReader` port (`readFile`, `readDir`, `exists`) that every repo-reading consumer shares, plus a GitHub contents-API implementation (for the proposer, which holds only a read-only token) and an in-memory implementation (for tests, and proof the port is backend-independent). Degrades to an empty result instead of throwing on a missing path, auth failure, or rate limit. Imported by `@on-par/factory-core` (PLAN, the ADR reader, the design-smells checker and the review classifier use its filesystem reader `createFsReader`).
- **@on-par/factory-tui** — A read-only Ink TUI for a live view of the current Software Factory run. Imports `@on-par/factory-core`.

For contributor rules see [AGENTS.md](../AGENTS.md); for what works today see [status.md](status.md); for terminology see [CONTEXT.md](../CONTEXT.md).
