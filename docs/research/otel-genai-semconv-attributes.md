# OTel GenAI Attribute Names in the Pinned Semconv Version (Issue #1983)

Date: 2026-10-05

## Context

A later ADR (the `CostEntry` to OpenTelemetry mapping, #1968) will map the
factory's per-invocation cost rows to `gen_ai.*` attributes. This spike checks
which names actually exist in one pinned semconv release, so the ADR does not
name attributes that do not exist. Docs only; no code changes. The ADR mapping
table itself is out of scope.

## Pinned version

Pinned: **OpenTelemetry semantic conventions v1.41.1**
(`open-telemetry/semantic-conventions` tag `v1.41.1`, commit
`ead83b9b0fa36540c1642fce46e874f002ac23f1`, 2026-05-11). Source file checked:
`model/gen-ai/registry.yaml` at that tag. Schema URL
`https://opentelemetry.io/schemas/1.41.1`. Every gen_ai attribute there has
stability `development`.

Why this version: it is the last tagged core release where `gen_ai.*`
attributes are live definitions. In v1.42.0 through v1.44.0 (the latest tag on
2026-10-05), core semconv keeps them only as deprecated entries with the note
"Moved to the OpenTelemetry GenAI semantic conventions repository". The new
home, `open-telemetry/semantic-conventions-genai`, has no release tag yet. Its
`model/manifest.yaml` declares
`schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev` and
`stability: development`, and its CHANGELOG is "Unreleased". Checked at commit
`e07f4ebacb08f56db8c4c882d117720333fbca04`, 2026-10-02.

## Existing names in v1.41.1

| CostEntry concept         | Attribute                                  | Type        | Note                                                                          |
| ------------------------- | ------------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `inputTokens`             | `gen_ai.usage.input_tokens`                | int         | SHOULD include all input tokens, including cached. Matches `inputTokens`.     |
| `outputTokens`            | `gen_ai.usage.output_tokens`               | int         |                                                                               |
| `cacheReadTokens`         | `gen_ai.usage.cache_read.input_tokens`     | int         | Input tokens served from a provider-managed cache; SHOULD be in input_tokens. |
| `cacheCreationTokens`     | `gen_ai.usage.cache_creation.input_tokens` | int         | Input tokens written to a provider-managed cache; SHOULD be in input_tokens.  |
| `model` (requested)       | `gen_ai.request.model`                     | string      |                                                                               |
| `model` (reported)        | `gen_ai.response.model`                    | string      | The factory records one `model`; which one it maps to is left to the ADR.     |
| provider (from model)     | `gen_ai.provider.name`                     | enum string | Replaces the deprecated `gen_ai.system`. Well-known values listed below.      |
| `task` (operation, part.) | `gen_ai.operation.name`                    | string      | Values such as `chat`, `invoke_agent`. Factory tasks are not among them.      |

`CostEntry.inputTokens` already includes the cache split (`rawInputTokens` is
inputTokens minus the cache split), which agrees with upstream's "include cached
tokens" wording.

Well-known `gen_ai.provider.name` values: openai, gcp.gen_ai, gcp.vertex_ai,
gcp.gemini, anthropic, cohere, azure.ai.inference, azure.ai.openai,
ibm.watsonx.ai, aws.bedrock, perplexity, x_ai, deepseek, groq, mistral_ai.

Also present but not recorded by the factory today:
`gen_ai.usage.reasoning.output_tokens` and `gen_ai.response.id`. On the metrics
side, `gen_ai.client.token.usage` (with `gen_ai.token.type` of `input` or
`output`) and `gen_ai.client.operation.duration` exist. Do not use the
deprecated `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens` or
`gen_ai.system`.

## Forward-looking caveat

In unreleased `semantic-conventions-genai` (commit `e07f4eb…`),
`changelog.d/440.breaking.md` renames `gen_ai.usage.cache_creation.input_tokens`
to `gen_ai.usage.cache_write.input_tokens`. `changelog.d/469.breaking.md`
removes the cache_read/cache_write attributes from the `invoke_agent` span and
says to aggregate them from inference client spans instead. That repo also adds
per-modality usage names (for example `gen_ai.usage.text.input_tokens`). The
mapping ADR must pick one name for cache creation and say how it migrates.

## Gaps: no gen_ai attribute

None of these has a `gen_ai.*` attribute in v1.41.1; the registry has no cost,
price, retry, failover or estimate attribute. The `factory.*` names are
proposals only; the mapping ADR decides them.

| CostEntry field    | Meaning                                                   | Proposed name                    | Type                                                          |
| ------------------ | --------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `cost`             | USD cost of the invocation, null when unknown (ADR-0020)  | `factory.cost.usd`               | double; omit when null, never send 0                          |
| `unpriced`         | no price known for the model                              | `factory.cost.unpriced`          | boolean                                                       |
| `estimated`        | token counts are the char-count heuristic, not provider's | `factory.usage.estimated`        | boolean                                                       |
| `retryCause`       | row is a retry attempt                                    | `factory.retry.cause`            | string: `checker`, `failover`, `timeout`, `other`             |
| `failoverReason`   | why the router failed over                                | `factory.failover.reason`        | string: a `FailoverReason` value (see below)                  |
| `rawInputTokens`   | uncached input tokens                                     | `factory.usage.raw_input_tokens` | int; derivable as input minus cache_read minus cache_creation |
| `task`             | factory phase/task                                        | `factory.task`                   | string                                                        |
| `issue`            | issue being worked                                        | `factory.issue`                  | string                                                        |
| `numTurns`         | agentic-loop turns from the CLI envelope                  | `factory.agent.turns`            | int                                                           |
| `durationMs`       | CLI wall-clock ms                                         | `factory.duration.cli_ms`        | int                                                           |
| `durationApiMs`    | API-time ms                                               | `factory.duration.api_ms`        | int                                                           |
| `duration`         | router-measured ms                                        | `factory.duration.router_ms`     | int; span duration may cover it                               |
| `reworkRoundCount` | rework rounds so far in the run                           | `factory.rework.round_count`     | int                                                           |
| `sandboxRuntime`   | resolved sandbox runtime                                  | `factory.sandbox.runtime`        | string                                                        |
| `workspaceBackend` | `worktree` or `disposable-docker`                         | `factory.workspace.backend`      | string                                                        |

`FailoverReason` members today: `rate_limit`, `usage_cap`, `timeout`, `error`,
`empty_response`, `unavailable`, `local_auth`, `schema_invalid`,
`apply_failed`, `verify_failed`, `unknown`. `gen_ai.client.operation.duration`
is in seconds, so the router duration needs a unit decision in the ADR.

## Sources

- https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml
- https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/docs/registry/attributes/gen-ai.md
- https://github.com/open-telemetry/semantic-conventions-genai
- `packages/core/src/types/index.ts` (`CostEntry`)
