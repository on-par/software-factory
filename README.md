# Software Factory

A multi-agent software factory that ships verified work autonomously. Built in TypeScript/Node.js with the **boss-worker-checker** orchestration pattern, **model routing** that tries free local models first and fails over across providers automatically, per-task **cost tracking** (`factory cost`), and per-product **constitutions**.

## Status

Honest snapshot of what works today vs. what is experimental. Statuses reflect the actual code, not the roadmap.

| Feature                                               | Status          | Notes                                                                                                                                 |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `factory ship` pipeline (PLAN → BUILD → CHECK → SHIP) | ✅ Working      | Covered by an end-to-end pipeline integration test                                                                                    |
| `factory triage` (queue from open issues)             | ✅ Working      |                                                                                                                                       |
| `factory run` (parallel lanes)                        | ✅ Working      | Merges are serialized per lane via a merge-wait step                                                                                  |
| `factory land` / auto-merge                           | ✅ Working      | Auto-merge is **off by default** (`merge.auto: false`); set `FACTORY_MERGE=1` to enable autonomous squash-merge                       |
| `factory supervise` (multi-window unattended runs)    | ✅ Working      | Waits for usage headroom, runs the queue, repeats until drained                                                                       |
| Usage-cap watchdog (`factory usage`, stop-at-cap)     | ✅ Working      | Trailing-5h cost-weighted usage vs. cap (Claude models only); lanes stop at the cap                                                   |
| Codex worker builds (`codex exec`)                    | ✅ Working      | Used for the `build_codex` route                                                                                                      |
| Claude models via the Claude CLI (`claude -p`)        | ✅ Working      | TRIAGE always shells out to `claude -p`; PLAN routes through the boss tier (local models first, Claude as failover)                   |
| Harness dispatch (per-model provider adapters)        | ✅ Working      | Each model declares a `harness` in `models.json`: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`              |
| GPT worker models via the Codex CLI                   | ✅ Working      | `gpt-5.6-sol` → `gpt-5.1-codex`, dispatched through the `codex-cli` harness                                                           |
| Local Ollama + OpenCode models                        | ⚠️ Experimental | Harnesses are contract-tested, but real-run behavior is unverified — expect failover to a cloud model                                 |
| DeepSeek / gpt-4.1-mini via `claude --model ...`      | ⚠️ Experimental | The Claude CLI only serves Anthropic models; this wiring is unproven                                                                  |
| Prompt evals (`npm run eval`)                         | ✅ Working      | Deterministic stub subset runs in CI on every PR; weekly real run checks prompt/constitution/skill regressions under pinned model IDs |
| Cost tracking (`factory cost`)                        | ✅ Working      | Per-task tokens and cost logged to `.factory/costs.jsonl`                                                                             |
| Constitutions + checker rework loop                   | ✅ Working      | Up to 3 rework rounds with dispute resolution                                                                                         |
| Server (`packages/server`)                            | 🚧 Stub         | Exports config types only; `createServer()` throws — Phase 2 of the roadmap                                                           |

## Monorepo Structure

```
software-factory/
├── packages/
│   ├── core/         @on-par/factory-core     — Engine: router, constitutions, checkers, phases
│   ├── cli/          @on-par/factory-cli      — CLI app (factory init, ship, run, triage, ...)
│   ├── config/       @on-par/factory-config   — Shared JSON configs + product constitutions
│   └── server/       @on-par/factory-server   — SaaS server (stub — Phase 2 of roadmap)
├── tsconfig.base.json
└── package.json      (npm workspaces root)
```

### Package Dependencies

```
config  ←  core  ←  cli
                ←  server
```

- **@on-par/factory-config** — Zero dependencies. Ships `models.json`, `routes.json`, `factory.json`, and constitution markdown files.
- **@on-par/factory-core** — The engine. Model registry, router with failover, constitution loader, checker framework, and the four pipeline phases (PLAN → BUILD → CHECK → SHIP). Imports config.
- **@on-par/factory-cli** — The `factory` CLI. Imports core.
- **@on-par/factory-server** — Future SaaS server. Imports core. Currently a stub.

## Quick Start (5 minutes)

**Prerequisites**

- Node.js ≥ 20
- `git` and the GitHub CLI `gh`, authenticated (`gh auth login`) — the factory uses `gh repo view` to detect your repo and polls CI checks via the GitHub API when landing
- Claude Code CLI (`claude`) on PATH — the TRIAGE phase shells out to `claude -p`, and Claude models in every tier dispatch through it
- Optional: OpenAI Codex CLI (`codex`) for cheap worker builds, and `ollama` for free local worker models

**Step 1 — Install**

```bash
npm install -g @on-par/factory-cli
factory --version
```

Development alternative (clone and build from source):

```bash
git clone https://github.com/on-par/software-factory
cd software-factory
npm install
npm run build
npm link --workspace @on-par/factory-cli
```

**Step 2 — Point it at your repo**

```bash
cd /path/to/your/repo        # any git repo with a GitHub remote and open issues
export GITHUB_TOKEN=$(gh auth token)   # the factory opens PRs via the GitHub API
factory init                 # creates .factory/ (state, logs, plans, queue)
```

**Step 3 — Pick a constitution**

```bash
factory constitution --list                    # see available product constitutions
factory constitution --product example-marketing-site
```

**Step 4 — Triage the backlog**

```bash
factory triage               # proposes .factory/queue.proposed from your open issues — review it, then:
mv .factory/queue.proposed .factory/queue
```

**Step 5 — Ship your first issue**

```bash
factory ship 42              # PLAN → BUILD → CHECK → SHIP one issue (use an issue number from your repo)
```

`factory ship` ends at a green, ready-for-review PR that closes the issue (it prints `✅ Issue #N → PR #M ready for review`); merging stays with you — review the PR and merge it, or run `factory land <N>` to squash-merge and clean up the worktree. To process the whole triaged queue in parallel lanes instead, run `factory run` (after accepting a triage proposal with the `mv` above).

## CLI Commands

```bash
factory init                        Initialize .factory in this repo
factory constitution --list         List available product constitutions
factory constitution --product <p>  Set the active constitution
factory constitution --init <p>     Scaffold a new product constitution from the template
factory models [--doctor]           List available models and costs; --doctor checks provider CLIs
factory triage [--product <p>]      Propose queue.proposed from open issues (review + mv to accept)
factory ship <N>                    Plan → build → check → ship one issue (--product, --no-auto-rework)
factory local-small-dry-run <N>     Dry-run an issue against local small models (--spec, --output)
factory land <N>                    Squash-merge a ready PR and clean up its worktree
factory run                         Process the whole queue (lanes in parallel)
factory supervise [--now]           Unattended loop: wait for usage headroom, run the queue, repeat
factory status                      Show queue, events, PRs, models
factory cost                        Show cost tracking summary
factory usage                       Report trailing-5h subscription usage vs cap
factory stop                        Halt between issues
factory resume                      Resume after stop
```

## Model Routing

Each task type maps to a tier, and each tier is a hand-ordered priority list in `models.json` — free local models first, then cloud models ranked by capability. The router takes the first available model in the list; when a model hits a usage limit, rate limit, or error, it automatically fails over to the next one. (`models.json` is the source of truth; the snapshot below can drift.)

| Tier    | Priority order (experimental models excluded)                                                                       | Cloud cost $/M output | Use                     |
| ------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------- |
| boss    | qwen2.5-coder:14b → gemma4:12b → claude-fable-5 → claude-opus-4-8 → claude-sonnet-5                                 | $40 → $25 → $15       | Specs, design, disputes |
| worker  | codex-ollama-qwen3.5:9b → qwen2.5-coder:14b → qwen3.5:9b → qwen3:8b → gpt-5.6-sol → gpt-5.1-codex → claude-sonnet-5 | $10 → $10 → $15       | Implementation          |
| checker | qwen3.5:9b → gemma4:12b → qwen2.5-coder:14b → qwen3:8b → claude-sonnet-5                                            | $15                   | Verification            |
| triage  | qwen2.5-coder:14b → claude-sonnet-5                                                                                 | $15                   | Issue triage            |

Local Ollama models cost $0 and lead every tier. `FACTORY_LOCAL_ONLY=1` restricts routing to local models entirely. Experimental models (glm-5.2, deepseek-v3, qwen-3.5-coder, gpt-4.1-mini, opencode-sonnet) exist in `models.json` but are only routed when `FACTORY_EXPERIMENTAL=1`.

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

A constitution is a written standard that defines "done right" for a product. Every build round is tested against it.

- `packages/config/src/constitutions/example-marketing-site.md` — Static site generation (brand, WCAG 2.2 AA, SEO, links)
- `packages/config/src/constitutions/example-data-app.md` — Data analysis (data integrity, report validation)
- `packages/config/src/constitutions/example-client-delivery.md` — Client delivery (client brand adherence, tech spec)
- `packages/config/src/constitutions/_template.md` — Template for new products

## Open-Core Boundary & Safety

**What's OSS (this repo):** `packages/cli`, `packages/core`, and `packages/config` are the open-source core — the full local pipeline (router, constitutions, checkers, phases) runs from this repo alone, MIT-licensed.

**What isn't:** the hosted control plane (web dashboard, multi-tenant orchestration) lives in a separate repo and is not part of this codebase. `packages/server` here is a stub that reserves the integration point — it exports config types and a `createServer()` that throws.

**Safety note:** to run unattended, the factory invokes agent CLIs with permission checks disabled — `claude -p ... --dangerously-skip-permissions` and `codex exec --sandbox workspace-write --ask-for-approval never`. Every build runs inside an isolated git worktree (created as a sibling of your repo under the `ship-it/` branch prefix), never in your main checkout. The factory defaults to review mode: pipelines end at a green, ready-for-review PR and merging stays with you unless you explicitly opt in with `FACTORY_MERGE=1`. Only run the factory against repos where you accept agent-authored code executing in that worktree (builds run tests, install dependencies, etc.).

## SaaS Roadmap

1. **Phase 1 (current)** — CLI tool (`@on-par/factory-cli`), run locally against any git repo
2. **Phase 2** — Server mode (`@on-par/factory-server`) with GitHub webhook triggers
3. **Phase 3** — Sandboxed execution via Docker/Daytona — users point at a repo, factory runs in isolated containers
4. **Phase 4** — Multi-tenant SaaS with web dashboard, per-user model config, auto-merge policies

The monorepo structure means the server package can import `@on-par/factory-core` for the router, checkers, phases, and constitution loader without duplicating code. New apps (dashboard, sandbox runner, webhook handler) each get their own workspace package.

## License

MIT — On PAR Dev
