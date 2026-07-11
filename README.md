# Software Factory

A token-efficient, highly capable multi-agent software factory that ships verified work autonomously. Built in TypeScript/Node.js with the **boss-worker-checker** orchestration pattern, intelligent **model routing** with automatic **failover** across providers, and per-product **constitutions**.

## Monorepo Structure

```
software-factory/
├── packages/
│   ├── core/         @on-par/factory-core     — Engine: router, constitutions, checkers, phases
│   ├── cli/          @on-par/factory-cli      — CLI app (factory init, ship, run, triage, ...)
│   ├── config/       @on-par/factory-config   — Shared JSON configs + product constitutions
│   └── server/       @on-par/factory-server   — SaaS server (stub — Phase 2 of roadmap)
├── legacy/           Original bash version (preserved for reference)
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

## Quick Start

```bash
# Install all workspace packages
npm install

# Build everything
npm run build

# Link the CLI globally
npm link --workspace @on-par/factory-cli

# In any git repo with a GitHub remote:
factory init
factory constitution --product example-marketing-site
factory triage
factory run
```

## CLI Commands

```bash
factory init                        Initialize .factory in this repo
factory constitution --list         List available product constitutions
factory constitution --product <p>  Set the active constitution
factory models                      List available models and costs
factory triage                      Propose a queue from open issues
factory ship <N>                    Plan → build → check → ship one issue
factory run                         Process the whole queue (lanes in parallel)
factory status                      Show queue, events, PRs, models
factory cost                        Show cost tracking summary
factory stop                        Halt between issues
factory resume                      Resume after stop
```

## Model Routing

The router picks the cheapest model capable of each task type. When a model hits a usage limit, rate limit, or error, it automatically fails over to the next model in the tier.

| Tier | Models (priority order) | Cost $/M output | Use |
|------|------------------------|-----------------|-----|
| boss | claude-opus-4-8 → gpt-5.5 → claude-sonnet-5 | $50 → $10 → $15 | Specs, design, disputes |
| worker | glm-5.2 → deepseek-v3 → qwen-3.5-coder → gpt-5.5 → claude-sonnet-5 | $0.50 → $0.28 → $0.20 → $10 → $15 | Implementation |
| checker | claude-sonnet-5 → gpt-4.1-mini → glm-5.2 | $15 → $3 → $0.50 | Verification |
| triage | claude-sonnet-5 → glm-5.2 | $15 → $0.50 | Issue triage |

## Failover Triggers

| Trigger | Behavior |
|---------|----------|
| `rate_limit` (429) | Retry with cooldown (max 2), then failover |
| `usage_cap` (quota/billing) | Failover immediately to next model |
| `timeout` | Failover immediately |
| `error` | Retry once, then failover |
| `empty_response` | Failover immediately |

## Constitutions

A constitution is a written standard that defines "done right" for a product. Every build round is tested against it.

- `packages/config/src/constitutions/example-marketing-site.md` — Static site generation (brand, WCAG 2.2 AA, SEO, links)
- `packages/config/src/constitutions/example-data-app.md` — Data analysis (data integrity, report validation)
- `packages/config/src/constitutions/example-client-delivery.md` — Client delivery (client brand adherence, tech spec)
- `packages/config/src/constitutions/_template.md` — Template for new products

## SaaS Roadmap

1. **Phase 1 (current)** — CLI tool (`@on-par/factory-cli`), run locally against any git repo
2. **Phase 2** — Server mode (`@on-par/factory-server`) with GitHub webhook triggers
3. **Phase 3** — Sandboxed execution via Docker/Daytona — users point at a repo, factory runs in isolated containers
4. **Phase 4** — Multi-tenant SaaS with web dashboard, per-user model config, auto-merge policies

The monorepo structure means the server package can import `@on-par/factory-core` for the router, checkers, phases, and constitution loader without duplicating code. New apps (dashboard, sandbox runner, webhook handler) each get their own workspace package.

## License

MIT — On PAR Dev