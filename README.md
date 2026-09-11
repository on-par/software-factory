# Software Factory

A multi-agent software factory that ships verified work autonomously. Built in TypeScript/Node.js with the **boss-worker-checker** orchestration pattern, **model routing** that tries free local models first and fails over across providers automatically, per-task **cost tracking** (`factory cost`), and per-product **constitutions**.

## Status

Honest snapshot of what works today vs. what is experimental. Statuses reflect the actual code, not the roadmap.

| Feature                                               | Status          | Notes                                                                                                                                                                           |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory ship` pipeline (PLAN → BUILD → CHECK → SHIP) | ✅ Working      | Covered by an end-to-end pipeline integration test                                                                                                                              |
| `factory triage` (queue from open issues)             | ✅ Working      |                                                                                                                                                                                 |
| `factory run` (parallel lanes)                        | ✅ Working      | Merges are serialized per lane via a merge-wait step                                                                                                                            |
| `factory land` / auto-merge                           | ✅ Working      | Auto-merge is **off by default** (`merge.auto: false`); set `FACTORY_MERGE=1` to enable autonomous squash-merge; add `FACTORY_MERGE_ADMIN=1` only when admin bypass is intended |
| `factory supervise` (multi-window unattended runs)    | ✅ Working      | Waits for usage headroom, runs the queue, repeats until drained                                                                                                                 |
| Usage-cap watchdog (`factory usage`, stop-at-cap)     | ✅ Working      | Trailing-5h cost-weighted usage vs. cap (Claude models only); lanes stop at the cap                                                                                             |
| Codex worker builds (`codex exec`)                    | ✅ Working      | Used for the `build_codex` route                                                                                                                                                |
| Claude models via the Claude CLI (`claude -p`)        | ✅ Working      | TRIAGE always shells out to `claude -p`; PLAN routes through the boss tier (local models first, Claude as failover)                                                             |
| Harness dispatch (per-model provider adapters)        | ✅ Working      | Each model declares a `harness` in `defaults.ts`: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`                                                        |
| GPT worker models via the Codex CLI                   | ✅ Working      | `gpt-5.6-terra` (plan=high / build=medium) → `gpt-5.6-sol` → `gpt-5.1-codex`, dispatched through the `codex-cli` harness                                                        |
| Local Ollama + OpenCode models                        | ⚠️ Experimental | Harnesses are contract-tested, but real-run behavior is unverified — expect failover to a cloud model                                                                           |
| DeepSeek / gpt-4.1-mini via `claude --model ...`      | ⚠️ Experimental | The Claude CLI only serves Anthropic models; this wiring is unproven                                                                                                            |
| Prompt evals (`npm run eval`)                         | ✅ Working      | Deterministic stub subset runs in CI on every PR; weekly real run checks prompt/constitution/skill regressions under pinned model IDs                                           |
| Cost tracking (`factory cost`)                        | ✅ Working      | Per-task tokens and cost logged to `.factory/costs.jsonl`                                                                                                                       |
| Constitutions + checker rework loop                   | ✅ Working      | Up to 3 rework rounds with dispute resolution                                                                                                                                   |
| Server (`packages/server`)                            | ✅ Working      | Loopback `GET /events` relays the lane lifecycle bus as SSE, `Last-Event-ID` resume via a bounded replay ring — no auth, no control endpoints yet                               |

## Monorepo Structure

```
software-factory/
├── packages/
│   ├── core/         @on-par/factory-core     — Engine: router, constitutions, checkers, phases
│   ├── cli/          @on-par/factory-cli      — CLI app (factory init, ship, run, triage, ...)
│   ├── config/       @on-par/factory-config   — Shared JSON configs + product constitutions
│   ├── contracts/    @on-par/contracts        — Shared typed seam: Issue/Epic/Story/DesignArtifact schemas
│   ├── adr-kit/      @on-par/adr-kit          — Pure ADR kernel: parse/serialize/template/numbering, zero deps
│   ├── repo-context/ @on-par/repo-context     — Read-only repo reader port: GitHub contents-API + in-memory, zero deps
│   └── server/       @on-par/factory-server   — Local HTTP server: GET /events relays the lane lifecycle bus as SSE
├── tsconfig.base.json
└── package.json      (npm workspaces root)
```

### Package Dependencies

```
config      ←  core  ←  cli
contracts   ←  core  ←  server
```

- **@on-par/factory-config** — Zero dependencies. Ships `defaults.ts` (typed model registry, route table, and factory defaults) and constitution markdown files.
- **@on-par/contracts** — Zero dependencies besides zod. Zod schemas + inferred types for the engineering-ready Issue/Epic/Story, Gherkin AcceptanceCriterion, and DesignArtifact shapes PLAN emits and BUILD consumes.
- **@on-par/factory-core** — The engine. Model registry, router with failover, constitution loader, checker framework, and the four pipeline phases (PLAN → BUILD → CHECK → SHIP). Imports config and contracts.
- **@on-par/factory-cli** — The `factory` CLI. Imports core.
- **@on-par/factory-server** — Local HTTP server. `GET /events` relays the lane lifecycle bus as SSE, with `Last-Event-ID` resume via a bounded replay ring. Depends only on `@on-par/contracts` — no auth, loopback-only.
- **@on-par/adr-kit** — Zero runtime dependencies. Pure, no-I/O ADR kernel: parses ADR markdown into a typed record, serializes it back byte-stably, models the repo's ADR convention (Nygard fallback, or inferred/reused when the repo already has ADRs), and provides next-number and index-table helpers. Not yet imported anywhere — the ADR reader, ADR writer, and readiness-conformance checker consume it in later stories of epic #464.
- **@on-par/repo-context** — Zero runtime dependencies. Defines the `RepoContextReader` port (`readFile`, `readDir`, `exists`) that every repo-reading consumer shares, plus a GitHub contents-API implementation (for the proposer, which holds only a read-only token) and an in-memory implementation (for tests, and proof the port is backend-independent). Degrades to an empty result instead of throwing on a missing path, auth failure, or rate limit. Not yet imported anywhere — later stories of epic #464 wire it into the proposer and writer.

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

`factory ship` ends at a green, ready-for-review PR that closes the issue (it prints `✅ Issue #N → PR #M ready for review`); merging stays with you — review the PR and merge it, or run `factory land <N>` to squash-merge and clean up the worktree. To process the whole triaged queue in parallel lanes instead, run `factory run` (after accepting a triage proposal with the `mv` above). `FACTORY_MERGE` / `FACTORY_MERGE_ADMIN` apply to `factory run` and `factory land` only — `factory ship` warns and ignores them.

## CLI Commands

```bash
factory init                        Initialize .factory in this repo
factory constitution --list         List available product constitutions
factory constitution --product <p>  Set the active constitution
factory constitution --init [p]     Scaffold .factory/constitution.md in this repo from the template
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

Each task type maps to a tier, and each tier is a hand-ordered priority list in `defaults.ts` — free local models first, then cloud models ranked by capability. The router takes the first available model in the list; when a model hits a usage limit, rate limit, or error, it automatically fails over to the next one. (`defaults.ts` is the source of truth; the snapshot below can drift.)

| Tier    | Priority order (experimental models excluded)                                                                                              | Cloud cost $/M output | Use                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------- |
| boss    | qwen2.5-coder:14b → gemma4:12b → claude-fable-5 → claude-opus-4-8 → claude-sonnet-5 → gpt-5.6-terra-high                                   | $40 → $25 → $15       | Specs, design, disputes |
| worker  | codex-ollama-qwen3.5:9b → qwen2.5-coder:14b → qwen3.5:9b → qwen3:8b → gpt-5.6-terra-medium → gpt-5.6-sol → gpt-5.1-codex → claude-sonnet-5 | $10 → $10 → $15       | Implementation          |
| checker | qwen3.5:9b → gemma4:12b → qwen2.5-coder:14b → qwen3:8b → claude-sonnet-5                                                                   | $15                   | Verification            |
| triage  | qwen2.5-coder:14b → claude-sonnet-5                                                                                                        | $15                   | Issue triage            |

Local Ollama models cost $0 and lead every tier. `FACTORY_LOCAL_ONLY=1` restricts routing to local models entirely. Experimental models (glm-5.2, deepseek-v3, qwen-3.5-coder, gpt-4.1-mini, opencode-sonnet) exist in `defaults.ts` but are only routed when `FACTORY_EXPERIMENTAL=1`.

**Codex GPT phase profiles.** Whenever Codex GPT is the selected provider path (e.g. `providers.anthropic`/`providers.ollama` disabled, or an explicit pin), PLAN defaults to `gpt-5.6-terra-high` (`model_reasoning_effort=high`) and BUILD (`build_codex`) defaults to `gpt-5.6-terra-medium` (`model_reasoning_effort=medium`); the generic `gpt-5.6-sol` → `gpt-5.1-codex` profiles remain as failover. Override per repo with `.factory/config.json` (`models.pins.plan` / `models.pins.build`) or per run with `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL`; the repo file wins over env.

**Model and effort selection.** GPT-6 Astra is available as `gpt-6-astra` through Codex subscription authentication (default effort: `medium`). Pin it explicitly; it does not change the default tier/failover order. In a v2 `.factory/config.json`, configure effort independently of model pins:

```json
{
  "version": 2,
  "models": {
    "pins": { "plan": "gpt-6-astra", "build": "gpt-6-astra", "checker": "claude-opus-5" },
    "efforts": {
      "gpt-6-astra": { "plan": "high", "build_codex": "medium" },
      "claude-opus-5": "high",
      "opencode-deepseek-v4-flash-free": "low",
      "qwen3.5:9b": false
    }
  },
  "route": "codex"
}
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

**What isn't:** the hosted control plane (web dashboard, multi-tenant orchestration) lives in a separate repo and is not part of this codebase. `packages/server` here is a real, narrow local server — its only route is `GET /events`, an SSE relay of the lane lifecycle bus, unauthenticated and loopback-only.

**Safety note:** to run unattended, the factory invokes agent CLIs with permission checks disabled — `claude -p ... --dangerously-skip-permissions` and `codex exec --sandbox workspace-write --ask-for-approval never`. Every build runs inside an isolated git worktree (created as a sibling of your repo under the `ship-it/` branch prefix), never in your main checkout. The factory defaults to review mode: pipelines end at a green, ready-for-review PR and merging stays with you unless you explicitly opt in with `FACTORY_MERGE=1`. Admin bypass is separate: set `FACTORY_MERGE_ADMIN=1` only when the active GitHub token should use administrator privileges to merge through unmet requirements. Only run the factory against repos where you accept agent-authored code executing in that worktree (builds run tests, install dependencies, etc.).

## SaaS Roadmap

1. **Phase 1 (current)** — CLI tool (`@on-par/factory-cli`), run locally against any git repo
2. **Phase 2** — Server mode (`@on-par/factory-server`) with GitHub webhook triggers
3. **Phase 3** — Sandboxed execution via Docker/Daytona — users point at a repo, factory runs in isolated containers
4. **Phase 4** — Multi-tenant SaaS with web dashboard, per-user model config, auto-merge policies

The monorepo structure means the server package can import `@on-par/factory-core` for the router, checkers, phases, and constitution loader without duplicating code. New apps (dashboard, sandbox runner, webhook handler) each get their own workspace package.

## License

MIT — On PAR Dev
