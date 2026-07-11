# Architecture

## Overview

The Software Factory is a multi-agent orchestration system that ships verified work autonomously. It combines three key ideas:

1. **Boss-Worker-Checker pattern** — expensive models plan and judge, cheap models implement, independent checkers verify. No rank skips verification.
2. **Multi-provider model routing** — tasks route to the cheapest capable model, with automatic failover when a provider hits limits.
3. **Constitutions** — per-product written standards enforced on every task. The prompt isn't instructions; it's a standard plus a way to check it.

## The Pipeline

```
Issue → PLAN → BUILD → CHECK → SHIP → PR (ready for review)
         (boss)  (worker) (checker)  (factory)
```

### PLAN (Boss Model)
- Reads the issue, explores the repo, loads the constitution
- Freezes a written spec to `.factory/plans/issue-N.md`
- Picks a build route: `codex` (bounded/mechanical) or `claude` (design/UX)
- The boss never codes — it writes specs and judges

### BUILD (Worker Model)
- Receives the frozen spec + constitution
- Implements the work in an isolated git worktree
- For `route: codex`: Codex CLI implements + commits (no push/PR)
- For `route: claude`: Claude implements + runs ship-it pipeline
- The worker's self-report is ignored by the checker

### CHECK (Checker Agent)
- Independent verification of the worker's output
- Runs standard checkers (compile, tests, lint, links, accessibility)
- Runs product-specific custom checkers from the constitution
- Failures go back to the worker with specific feedback (rework loop, max 3 rounds)
- Worker can dispute a checker failure → boss arbitrates by re-reading the constitution

### SHIP
- Push branch, create/verify PR, mark ready for review
- CI watched (best-effort)
- No autonomous merge without `FACTORY_MERGE=1`

## Model Routing

The router (`lib/router.sh`) resolves task types to models:

1. **Look up tier** — each task type maps to a tier (boss, worker, checker, triage) via `config/routes.json`
2. **Walk the tier** — models listed in priority order in `config/models.json`
3. **Filter by availability** — skip models without env keys (BYOK), or without Codex binary
4. **Failover** — on rate limit, usage cap, timeout, or error, automatically try the next model

### Failover triggers

| Trigger | Behavior |
|---------|----------|
| `rate_limit` (429) | Retry with cooldown (max 2), then failover |
| `usage_cap` (quota/billing) | Failover immediately to next model |
| `timeout` | Failover immediately |
| `error` | Retry once, then failover |
| `empty_response` | Failover immediately |

### Cost tiers (mid-2026)

| Tier | Models (priority order) | Use |
|------|------------------------|-----|
| boss | claude-opus-4-8 → gpt-5.5 → claude-sonnet-5 | Specs, design, disputes |
| worker | glm-5.2 → deepseek-v3 → qwen-3.5-coder → gpt-5.5 → claude-sonnet-5 | Implementation |
| checker | claude-sonnet-5 → gpt-4.1-mini → glm-5.2 | Verification |
| triage | claude-sonnet-5 → glm-5.2 | Issue triage |

## Constitutions

A constitution is a markdown file in `constitutions/` with:
- **Frontmatter** — product name, version, checker list, enforced phases
- **Standards** — concrete, testable criteria for "done right"
- **Quality Gates** — which checkers must pass
- **Dispute Rules** — how the boss arbitrates worker-checker conflicts
- **Non-Goals** — explicitly out of scope

The constitution is loaded in PLAN, BUILD, and CHECK phases. Checkers verify against the standards, not against the worker's self-report.

## Dispute Resolution

```
Worker fails check → rework loop (max 3 rounds)
  ├── Worker fixes → re-check → pass or fail
  └── Worker disputes → Boss re-reads constitution → uphold or overrule
       ├── Upheld: worker must fix
       └── Overruled: checker was wrong, work passes
```

This handles the "who checks the checkers" problem. The boss is the final authority, but it decides by referencing the constitution — not by subjective judgment.

## Cost Tracking

Every task logs token usage and cost to `.factory/costs.jsonl`. View with `factory cost`.

The 10x cost reduction comes from routing implementation work to cheap models (GLM 5.2 at $0.50/M) while reserving expensive models (Claude Opus at $50/M) for planning and dispute resolution only.