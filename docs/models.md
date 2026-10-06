# Model Routing

Run `factory models` to list models with tiers, cost and availability, and `factory models --doctor` to probe provider CLIs.

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
