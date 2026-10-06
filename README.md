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

Each task type maps to a tier, and each tier is a hand-ordered priority list in `defaults.ts` — free local models first, then cloud models ranked by capability. The router takes the first available model in the list; when a model hits a usage limit, rate limit, or error, it automatically fails over to the next one. (`defaults.ts` is the source of truth; the snapshot below can drift.)

| Tier    | Priority order (experimental models excluded)                                                                                              | Cloud cost $/M output | Use                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------- |
| boss    | qwen2.5-coder:14b → gemma4:12b → claude-fable-5 → claude-opus-4-8 → claude-sonnet-5 → gpt-5.6-terra-high                                   | $40 → $25 → $15       | Specs, design, disputes |
| worker  | codex-ollama-qwen3.5:9b → qwen2.5-coder:14b → qwen3.5:9b → qwen3:8b → gpt-5.6-terra-medium → gpt-5.6-sol → gpt-5.1-codex → claude-sonnet-5 | $10 → $10 → $15       | Implementation          |
| checker | qwen3.5:9b → gemma4:12b → qwen2.5-coder:14b → qwen3:8b → claude-sonnet-5                                                                   | $15                   | Verification            |
| triage  | qwen2.5-coder:14b → claude-sonnet-5                                                                                                        | $15                   | Issue triage            |

Local Ollama models cost $0 and lead every tier. `FACTORY_LOCAL_ONLY=1` restricts routing to local models entirely. Experimental models (glm-5.2, deepseek-v3, qwen-3.5-coder, gpt-4.1-mini, opencode-sonnet) exist in `defaults.ts` but are only routed when `FACTORY_EXPERIMENTAL=1`.

**Codex GPT phase profiles.** Whenever Codex GPT is the selected provider path (e.g. `providers.anthropic`/`providers.ollama` disabled, or an explicit pin), PLAN defaults to `gpt-5.6-terra-high` (`model_reasoning_effort=high`) and BUILD (`build_codex`) defaults to `gpt-5.6-terra-medium` (`model_reasoning_effort=medium`); the generic `gpt-5.6-sol` → `gpt-5.1-codex` profiles remain as failover. Override per repo with `.factory/config.yaml` (`models.pins.plan` / `models.pins.build`) or per run with `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL`; the repo file wins over env.

**Model and effort selection.** GPT-6 Astra is available as `gpt-6-astra` through Codex subscription authentication (default effort: `medium`). Pin it explicitly; it does not change the default tier/failover order. In a v2 `.factory/config.yaml`, configure effort independently of model pins:

```yaml
version: 2
models:
  pins: { plan: gpt-6-astra, build: gpt-6-astra, checker: claude-opus-5 }
  efforts:
    gpt-6-astra: { plan: high, build_codex: medium }
    claude-opus-5: high
    opencode-deepseek-v4-flash-free: low
    'qwen3.5:9b': false
route: codex
```

Each `efforts` key is a registered model ID. A scalar applies to every task for that model; a map applies only to its named task types (for example `plan`, `build_codex`, `build_claude`, `build_opencode`, `check_custom`, `review_pr`, or `triage`; see the routes in `defaults.ts`). Unspecified models/tasks keep their current profile/provider defaults. A fallback uses its own effort configuration. Existing string model pins and `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL` still work. `factory status --kpis` shows configured effort overrides.

| Harness                                | Native setting                            | Accepted effort values                                              |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Codex                                  | `-c model_reasoning_effort=...`           | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Claude Code                            | `--effort` and `CLAUDE_CODE_EFFORT_LEVEL` | `low`, `medium`, `high`, `xhigh`, `max`                             |
| OpenCode                               | `--variant`                               | Named effort levels listed for Codex above                          |
| Ollama HTTP / agentic / command worker | `think`                                   | `true`, `false`, `low`, `medium`, `high`, `max`                     |

These are transport options, not a guarantee that every model supports every level. Use a level/variant supported by your selected model and installed CLI; the provider controls model-specific availability and may reject or normalize unsupported levels. Astra in the installed Codex catalog supports `low` through `ultra`; it does not support `none` or `minimal`. Claude's explicit factory effort also overrides inherited `CLAUDE_CODE_EFFORT_LEVEL`. Unknown model IDs, invalid values, and unsupported harness/value combinations fail before execution.

Native references: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude effort](https://code.claude.com/docs/en/model-config#adjust-effort-level), [OpenCode variants](https://opencode.ai/docs/cli/#run), [Ollama thinking](https://docs.ollama.com/capabilities/thinking). Test the factory wiring without credentials or model calls with `npx vitest run packages/core/src/harness/effort.test.ts`.

Every model declares a **harness** — the provider adapter that executes it: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, or `opencode`. Build tasks require an agentic (file-editing) harness; prompt-only harnesses like `ollama-http` are rejected for builds. Per-task tokens and cost are logged to `.factory/costs.jsonl` (`factory cost` to inspect).

## Failover Triggers

| Trigger                     | Behavior                                   |
| --------------------------- | ------------------------------------------ |
| `rate_limit` (429)          | Retry with cooldown (max 2), then failover |
| `usage_cap` (quota/billing) | Failover immediately to next model         |
| `timeout`                   | Failover immediately                       |
| `error`                     | Retry once, then failover                  |
| `empty_response`            | Failover immediately                       |

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
