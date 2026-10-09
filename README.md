# Software Factory

A multi-agent software factory that ships verified work autonomously. Built in TypeScript/Node.js with the **boss-worker-checker** orchestration pattern, **model routing** that tries free local models first and fails over across providers automatically, per-task **cost tracking** (`factory cost`), and per-product **constitutions**.

## Status

Honest snapshot of what works today vs. what is experimental. Statuses reflect the actual code, not the roadmap.

| Feature                                               | Status     | Notes                                                                                                                                                                           |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory ship` pipeline (PLAN → BUILD → CHECK → SHIP) | ✅ Working | Covered by an end-to-end pipeline integration test                                                                                                                              |
| `factory triage` (queue from open issues)             | ✅ Working |                                                                                                                                                                                 |
| `factory run` (parallel lanes)                        | ✅ Working | Merges are serialized per lane via a merge-wait step                                                                                                                            |
| `factory land` / auto-merge                           | ✅ Working | Auto-merge is **off by default** (`merge.auto: false`); set `FACTORY_MERGE=1` to enable autonomous squash-merge; add `FACTORY_MERGE_ADMIN=1` only when admin bypass is intended |
| `factory supervise` (multi-window unattended runs)    | ✅ Working | Waits for usage headroom, runs the queue, repeats until drained                                                                                                                 |
| Cost tracking (`factory cost`)                        | ✅ Working | Per-task tokens and cost logged to `.factory/costs.jsonl`                                                                                                                       |

Full matrix — including model harnesses, prompt evals, the server, and experimental local/Ollama models — is in [docs/status.md](docs/status.md).

## Monorepo Structure

An npm-workspaces monorepo. The Wave-1 publish packages:

```
packages/
├── cli/           @on-par/factory-cli      — the `factory` command
├── core/          @on-par/factory-core     — engine: router, phases, checkers
├── config/        @on-par/factory-config   — typed defaults + constitutions (zero deps)
├── contracts/     @on-par/contracts        — shared zod schemas (Issue/Epic/Story/Design)
├── tui/           @on-par/factory-tui      — read-only Ink TUI for a live run
├── adr-kit/       @on-par/adr-kit          — pure ADR kernel (zero deps)
└── repo-context/  @on-par/repo-context     — read-only repo reader port (zero deps)
```

Private workspaces (server, dashboard, product, scbench-adapter) also live here but are not published. For the dependency graph and per-package detail, see [docs/architecture.md](docs/architecture.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md) and the rules in [AGENTS.md](AGENTS.md).

## Quick Start (5 minutes)

**Prerequisites**

- Node.js ≥ 24 (the `engines.node` field in the root and `packages/cli` `package.json`)
- `git` and the GitHub CLI `gh`, authenticated (`gh auth login`) — the factory uses `gh repo view` to detect your repo and polls CI checks via the GitHub API when landing
- Claude Code CLI (`claude`) on PATH — the TRIAGE phase shells out to `claude -p`, and Claude models in every tier dispatch through it
- Optional: OpenAI Codex CLI (`codex`) for cheap worker builds, and `ollama` for free local worker models

**Step 1 — Install from source**

The `@on-par/*` packages are not on npm yet, so install the CLI from a clone:

```bash
git clone https://github.com/on-par/software-factory
cd software-factory
npm install
npm run build
npm link --workspace @on-par/factory-cli   # puts `factory` on your PATH
factory --version
```

> **Global npm install is not available yet.** `npm install -g @on-par/factory-cli` will work once the Wave-1 publish lands (epic #1566, blocked on #1560). Until then it returns a 404, so use the clone install above.

**Step 2 — Point it at your repo**

```bash
cd /path/to/your/repo        # any git repo with a GitHub remote and open issues
export GITHUB_TOKEN=$(gh auth token)   # the factory opens PRs via the GitHub API
factory init                 # creates .factory/ (config.yaml, constitution.md, state/)
```

**Step 3 — Pick a constitution**

```bash
factory constitution --list                    # see available product constitutions
factory constitution --product example-marketing-site
```

**Step 4 — Triage the backlog**

```bash
factory triage               # proposes .factory/queue.proposed from your open issues — review it, then:
factory triage accept        # validates the proposal and promotes it to .factory/queue
```

**Step 5 — Ship your first issue**

```bash
factory ship 42              # PLAN → BUILD → CHECK → SHIP one issue (use an issue number from your repo)
```

`factory ship` ends at a green, ready-for-review PR that closes the issue (it prints `✅ Issue #N → PR #M ready for review`); merging stays with you — review the PR and merge it, or run `factory land <N>` to squash-merge and clean up the worktree. To process the whole triaged queue in parallel lanes instead, run `factory run` (after accepting a triage proposal with `factory triage accept`). `FACTORY_MERGE` / `FACTORY_MERGE_ADMIN` apply to `factory run` and `factory land` only — `factory ship` warns and ignores them.

## Configuration

`factory init` writes a minimal `.factory/config.yaml`:

```yaml
version: 2
```

Every other key is optional. [`docs/config.example.yaml`](docs/config.example.yaml) lists each key the factory reads, with its default and what it does. It is generated from the config schemas (`npm run config-example`) and a test fails when it drifts, so it matches the code. Copy only the keys you want to change (comments included) into `.factory/config.yaml`; `.factory/config.json` is still read for existing repos, and `factory migrate --to-yaml` converts it. `factory status --kpis` prints the effective config.

## CLI Commands

The most-used commands, by the group `factory --help` lists them under. Run `factory --help` for the full, current list.

```bash
# Run work
factory ship <N>                    Plan → build → check one issue and open a ready-for-review PR; never merges
factory run-issue <N>               Like ship, but loads the issue first and exits 2 if it cannot be found
factory run-issue <N> --run-children Also run the child issues the size gate files when it splits <N>
factory run                         Claim queued issues and ship them, lanes in parallel; merges only when auto-merge is on
factory supervise [--now]           Unattended loop: wait for usage headroom, run the queue, repeat until it is empty
factory land <N>                    Squash-merge the issue's open PR once CI is green, then remove its worktree
factory stop / factory resume       Halt lanes after their current issue / clear the stop

# Setup
factory init                        Set up .factory/ in this repo and check model reachability
factory doctor                      Check your environment (git, claude, gh auth, GitHub token, npm, sandbox)
factory constitution --product <p>  Seed .factory/constitution.md from a bundled example constitution
factory models [--doctor]           List models with tiers, cost, and availability; --doctor probes provider CLIs

# Queue
factory triage [--product <p>]      Have a model propose a queue into .factory/queue.proposed
factory queue add <lane> <N...>     Queue GitHub issues into a lane (factory:queued labels)
factory check <N> [--json]          Read-only pre-flight: missing fields, and whether the size gate runs it as-is or would split it (alias: ready)

# Observe
factory status                      Show active runs, the GitHub queue, provider health, and recent events
factory status --json               One JSON object: STOP flag, provider breaker, active claims (--kpis ignored)
factory logs [--follow]             Print pipeline events
factory cost                        Show recorded model spend by model
factory usage                       Report 5-hour subscription usage
```

`factory check` exits 0 when the issue is ready and runs as-is, 1 when fields are missing, and 3 when it would split.

### `factory run-issue --run-children`

When the size gate decides an issue is too big, it files child issues and stops the run. Without the flag, `run-issue` exits 1, names the children, and suggests re-running with `--run-children`. With the flag, it runs those children itself:

- **Order.** Children run one at a time, in the build order the size gate filed them, under the same run lock as the parent.
- **Nested splits.** If a child is decomposed again, its new children replace it and run before the remaining siblings. No issue runs twice.
- **Closed children** are skipped.
- **Failures don't stop the run.** A child that fails or escalates is recorded, and the next child still runs.
- **`.factory/STOP`** is checked before each child starts. Once it is present, no further child starts, and the file is left in place (ADR-0111). A child already running finishes.
- **Summary.** At the end, `run-issue` prints one line per child: its PR, or why it failed, was skipped, or did not run.
- **No labels, no merge.** Like `ship`, it never touches the queue's `factory:*` labels and never merges. Each successful child ends at its own ready-for-review PR.

Exit codes: `0` when every child reached ready-for-review, was skipped as closed, or was replaced by its own children. `1` when any child failed or was not started because of STOP, or when the issue was decomposed and `--run-children` was not passed. `2` when the parent issue cannot be resolved, before any worktree or PR exists. If the issue is not decomposed, the flag changes nothing.

## Root npm scripts

| Script                                                            | What it does                                                                                                                                                                                                                                 | Runs in                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run test`                                                    | Vitest with coverage thresholds (the full-suite gate).                                                                                                                                                                                       | `verify.sh` (full path), CI                                               |
| `npm run test:integration`                                        | Pipeline integration suites.                                                                                                                                                                                                                 | Nightly workflow, on demand                                               |
| `npm run sim-monte-carlo -- [options]`                            | Headless simulator Monte Carlo runs: synthetic issues through fake PLAN→BUILD→CHECK→SHIP, no model or GitHub calls. Prints shipped/parked/escalated rates and exits 1 on a breached `--max-*-rate` threshold. `-- --help` lists the options. | On demand                                                                 |
| `npm run sandbox-ab-report -- [--costs <file>] [--events <file>]` | Docker-sandbox vs baseline A/B comparison over `.factory/costs.jsonl` and `.factory/events.ndjson` (defaults from `getFactoryPaths`), with a go/no-go recommendation (#656).                                                                 | On demand                                                                 |
| `npm run mutation`                                                | Stryker mutation testing (`stryker.conf.json`).                                                                                                                                                                                              | On demand only. Not part of `scripts/verify.sh` and not run by CI (#805). |

The commit gate is `bash scripts/verify.sh` (see the verify skill).

## Model Routing

Each task type maps to a tier of models in `packages/config/src/defaults.ts`. The router tries free local models first, then cloud models, and fails over to the next model on rate limits, usage caps, timeouts, or errors. Effort levels can be set per model and task in `.factory/config.yaml`. Run `factory models --doctor` to see which models and provider CLIs are reachable. Tier order, effort settings, harnesses, and failover triggers are documented in [docs/models.md](docs/models.md).

## Constitutions

A constitution is a written standard that defines "done right" for a product. Every build round is tested against it. The source of truth for a real product is `.factory/constitution.md` in the **target repo** — `factory init`, `factory constitution --init`, and `factory constitution --product <name>` all read from and write to that path, never to a file bundled with the factory itself.

The bundled files below are only templates and worked examples used to seed a new `.factory/constitution.md` (via `factory constitution --product <name>`):

- `packages/config/src/constitutions/example-marketing-site.md` — Static site generation (brand, WCAG 2.2 AA, SEO, links)
- `packages/config/src/constitutions/example-data-app.md` — Data analysis (data integrity, report validation)
- `packages/config/src/constitutions/example-client-delivery.md` — Client delivery (client brand adherence, tech spec)
- `packages/config/src/constitutions/_template.md` — Template for new products

### Lane environment (parallel e2e)

Each lane leases a port from `.factory/ports.json` and every build/check
command it runs (workers, `npm test`, lint, custom checkers) inherits:

| Variable              | Example                 |
| --------------------- | ----------------------- |
| `PORT`                | `3142`                  |
| `FACTORY_APP_PORT`    | `3142`                  |
| `FACTORY_BASE_URL`    | `http://127.0.0.1:3142` |
| `FACTORY_HEADLESS`    | `1`                     |
| `PLAYWRIGHT_HEADLESS` | `1`                     |

Product e2e suites should boot their app on `PORT` (strict-port) and point
their test runner's base URL at `FACTORY_BASE_URL` — the constitution
template scaffolds the full Playwright reference contract. When port
leasing is disabled, checks still run but a `environment_warning` event
flags the collision risk for app-testing worktrees. Factory-managed runs
are headless by default — e2e configs must honor `FACTORY_HEADLESS` (headed
runs are an explicit human opt-in outside the factory, or
`FACTORY_HEADLESS=0`); unlike the port vars, `FACTORY_HEADLESS` and
`PLAYWRIGHT_HEADLESS` are injected even when no port lease is configured.

## Open-Core Boundary & Safety

**What's OSS (this repo):** `packages/cli`, `packages/core`, and `packages/config` are the open-source core — the full local pipeline (router, constitutions, checkers, phases) runs from this repo alone, MIT-licensed.

**What isn't published:** `packages/dashboard` (web dashboard, Vite + React walking skeleton), `packages/product` (the proposer: brain-dump to engineering-ready issues), `packages/server` and `packages/scbench-adapter` (SlopCodeBench adapter) live in this monorepo as private workspaces and are not published to npm. A hosted multi-tenant control plane is not part of this codebase. `packages/server` is a real, narrow local server — its only route is `GET /events`, an SSE relay of the lane lifecycle bus, unauthenticated and loopback-only.

**Safety note:** to run unattended, the factory invokes agent CLIs with permission checks disabled — `claude -p ... --dangerously-skip-permissions` and `codex exec --sandbox workspace-write --ask-for-approval never`. Every build runs inside an isolated git worktree (created as a sibling of your repo under the `factory/` branch prefix; override per command with `--branch-prefix`), never in your main checkout. The factory defaults to review mode: pipelines end at a green, ready-for-review PR and merging stays with you unless you explicitly opt in with `FACTORY_MERGE=1`. Admin bypass is separate: set `FACTORY_MERGE_ADMIN=1` only when the active GitHub token should use administrator privileges to merge through unmet requirements. Only run the factory against repos where you accept agent-authored code executing in that worktree (builds run tests, install dependencies, etc.). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the verify gate, how to try one issue against a throwaway repo, and the factory-task issue template.

Security issues: see [SECURITY.md](SECURITY.md) — please report privately, not as a public issue.

## License

MIT — On PAR Dev
