# Model Routing

Run `factory models` to list models with tiers, cost and availability, and `factory models --doctor` to probe provider CLIs.

Which coding agent CLIs the factory supports, and how to install and sign in to each, is in [agents.md](agents.md).

Each task type maps to a tier, and each tier is a hand-ordered priority list in `defaults.ts` — free local models first, then cloud models ranked by capability. The router takes the first available model in the list; when a model hits a usage limit, rate limit, or error, it automatically fails over to the next one. (`defaults.ts` is the source of truth; the snapshot below can drift.)

| Tier    | Priority order (experimental models excluded)                                                                                              | Cloud cost $/M output | Use                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------- |
| boss    | qwen2.5-coder:14b → gemma4:12b → claude-fable-5 → claude-opus-4-8 → claude-sonnet-5 → gpt-5.6-terra-high                                   | $40 → $25 → $15       | Specs, design, disputes |
| worker  | codex-ollama-qwen3.5:9b → qwen2.5-coder:14b → qwen3.5:9b → qwen3:8b → gpt-5.6-terra-medium → gpt-5.6-sol → gpt-5.1-codex → claude-sonnet-5 | $10 → $10 → $15       | Implementation          |
| checker | qwen3.5:9b → gemma4:12b → qwen2.5-coder:14b → qwen3:8b → claude-sonnet-5                                                                   | $15                   | Verification            |
| triage  | qwen2.5-coder:14b → claude-sonnet-5 → gpt-5.6-luna-high                                                                                    | $15                   | Issue triage            |

Models whose agent CLI is not on PATH are skipped, so a machine with only the Codex CLI routes every phase (PLAN, BUILD, CHECK, review, triage) to Codex models, and a machine with only Claude Code routes to Claude models. PLAN only picks a build route that can run on the machine and logs a `model-override` line when it reroutes. To send a phase to a specific agent when both are installed, pin it in `.factory/config.json` (`models.pins.plan`, `build`, `checker`, `triage`), set `route`, or reorder `tiers`. `factory triage --model <id>` picks the triage model for one run.

**Stuck-run steward.** The steward has no packaged model and no Claude requirement. It uses the steward route's `model` pin when set, otherwise the first runnable boss-tier model (models whose CLI is missing are skipped), so a Codex-only machine uses `gpt-5.6-terra-high`. The boss tier has no OpenCode model, so on an OpenCode-only machine pin the steward route model (e.g. `opencode-deepseek-v4-flash`); otherwise the steward fails closed with a `route-misconfigured` escalation.

Local Ollama models cost $0 and lead every tier. `FACTORY_LOCAL_ONLY=1` restricts routing to local models entirely. Experimental models (glm-5.2, deepseek-v3, qwen-3.5-coder, gpt-4.1-mini, opencode-sonnet, opencode-deepseek-v4-flash, opencode-deepseek-v4-flash-free) exist in `defaults.ts` but are only routed when `FACTORY_EXPERIMENTAL=1`.

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

Every model declares a **harness** — the provider adapter that executes it: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, or `opencode`. Build tasks require an agentic (file-editing) harness; prompt-only harnesses like `ollama-http` are rejected for builds. OpenCode models are reachable when the opencode CLI is logged in (`opencode auth login`); `OPENCODE_API_KEY` is an optional override. Per-task tokens and cost are logged to `.factory/costs.jsonl` (`factory cost` to inspect).

What a harness receives, must return and how its failures are classified is specified in [harness-contract.md](./harness-contract.md).

## OpenCode-only profile

Use this profile when the OpenCode CLI is the only agent CLI on the machine. Every packaged OpenCode model (`opencode-sonnet`, `opencode-deepseek-v4-flash`, `opencode-deepseek-v4-flash-free`) is experimental and only in the `worker` tier, so the default tiers never pick one for PLAN, checker or triage.

Requirements:

- Set `FACTORY_EXPERIMENTAL=1` in the factory's environment. Without it the router drops experimental models from every tier, pinned tiers included, and `factory models` shows them as `experimental — set FACTORY_EXPERIMENTAL=1 to enable`.
- Have the `opencode` CLI on PATH and logged in (`opencode auth login`). `OPENCODE_API_KEY` is an optional override. `factory models --doctor` probes it.

```yaml
# .factory/config.yaml
version: 2
models:
  pins:
    plan: opencode-deepseek-v4-flash
    build: opencode-deepseek-v4-flash
    checker: opencode-deepseek-v4-flash
    triage: opencode-deepseek-v4-flash
route: opencode
```

| Phase          | Setting                                   | Recommended value            | Why                                                                                                                  |
| -------------- | ----------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PLAN           | `models.pins.plan`                        | `opencode-deepseek-v4-flash` | The boss tier has no OpenCode model.                                                                                 |
| Worker (BUILD) | `models.pins.build` and `route: opencode` | `opencode-deepseek-v4-flash` | `route: opencode` sends BUILD to `build_opencode`; a pinned build worker's harness also forces the route after PLAN. |
| Checker        | `models.pins.checker`                     | `opencode-deepseek-v4-flash` | The pin replaces the checker tier with this one model.                                                               |
| Triage         | `models.pins.triage`                      | `opencode-deepseek-v4-flash` | The pin replaces the triage tier with this one model.                                                                |

Swap in `opencode-deepseek-v4-flash-free` (OpenCode Zen free promo tier, no subscription quota, but request data may be used for training) or `opencode-sonnet` for any phase. `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL` still override plan/build per run, and the repo file wins over env.

## Failover Triggers

| Trigger                     | Behavior                                   |
| --------------------------- | ------------------------------------------ |
| `rate_limit` (429)          | Retry with cooldown (max 2), then failover |
| `usage_cap` (quota/billing) | Failover immediately to next model         |
| `timeout`                   | Failover immediately                       |
| `error`                     | Retry once, then failover                  |
| `empty_response`            | Failover immediately                       |

## Declaring a custom harness

Add a top-level `harnesses` section to `.factory/config.yaml` to name your own agent CLI, then reference its id from a `models.registry` model's `harness` field (and pin or tier that model). For a step-by-step walkthrough, see [Bring your own agent](agents.md#bring-your-own-agent).

```yaml
version: 2
harnesses:
  my-agent:
    command: my-agent
    prompt: stdin
    output: stdout
    agentic: true
    usage: none
    errorPatterns:
      rate_limit: '429|rate limit'
    probe: my-agent --version
models:
  registry:
    my-model:
      provider: custom
      tier: worker
      costPerMtokInput: 0
      costPerMtokOutput: 0
      contextWindow: 200000
      capabilities: [implementation]
      envKey: null
      harness: my-agent
  pins:
    plan: my-model
```

- `prompt`: `stdin`, `file` or `arg`.
- `output`: `stdout`, `file:{outFile}` or `jsonl-last-message`.
- `usage`: `none` or `jsonl`.
- `usage: jsonl` sums `input_tokens` and `output_tokens` from the JSON lines on stdout, either top-level or under a `usage` object. Lines without both counts are ignored.
- `errorPatterns` maps a failure reason (`rate_limit`, `usage_cap`, `timeout`, `error`, `empty_response`, `unavailable`, `local_auth`, `schema_invalid`, `apply_failed`, `verify_failed` or `unknown`) to a regular expression. Patterns are tested case-insensitively against stderr, then stdout, in declaration order, and only when the command exits non-zero; the first match selects the reason. A timeout always wins. A plain list of regular expressions is also accepted: a match is classified by the built-in rules (an unrecognised match becomes `error`).
- `errorPatterns` and `probe` (a command; exit 0 means reachable) are optional.
- Ids of built-in harnesses cannot be redeclared.
- The model can be pinned for PLAN, BUILD, CHECK and review. A BUILD pin needs `agentic: true` and runs the `build_command` task. A non-agentic build pin is refused when config loads.
- `factory doctor` and `factory models --doctor` run `probe` and report the harness as available (exit 0) or unavailable (with the failure). With no `probe`, the harness is reported as unverified, which is a warning and not a failure.
- A declared `agentic: true` harness used by a `models.registry` model counts as the coding agent in `factory doctor` when the first word of `command` is on PATH; when it is not, doctor names the configured command.

The factory runs the declared command through the built-in `command` harness, in the lane worktree:

- `{model}` is the provider model id, `{worktree}` is the lane worktree, and `{outFile}` is a temp file the factory reads back when `output` is `file:{outFile}`.
- Values are shell-escaped, so metacharacters reach the agent as literal text. Write placeholders unquoted in the template; the factory supplies the quoting.
- `prompt: arg` appends the prompt, and `prompt: file` appends the path of a temp prompt file, as the last argument. `prompt: stdin` pipes the prompt in.
- `command` is a reserved id and cannot be declared.
