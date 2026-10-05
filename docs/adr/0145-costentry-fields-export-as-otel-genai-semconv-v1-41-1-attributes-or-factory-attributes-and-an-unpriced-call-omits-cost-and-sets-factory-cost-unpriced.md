# ADR-0145: CostEntry fields export as OTel GenAI semconv v1.41.1 attributes or factory.* attributes, and an unpriced call omits cost and sets factory.cost.unpriced

- Status: Accepted
- Date: 2026-10-05

## Context

`CostEntry` rows have no recorded attribute mapping. Without one, each exporter or consumer could pick its own
names, use deprecated `gen_ai` names (`gen_ai.system`, `gen_ai.usage.prompt_tokens`,
`gen_ai.usage.completion_tokens`), or export an unpriced call as cost 0, which contradicts ADR-0020 (missing
cost data is unknown, never zero).

The research is in the #1983 spike note, `docs/research/otel-genai-semconv-attributes.md`. Semconv v1.41.1
holds the last live core `gen_ai.*` definitions; v1.42.0+ only deprecates them, and
`open-telemetry/semantic-conventions-genai` has no release. v1.41.1 defines no cost, retry, failover or
estimate attributes, so those need `factory.*` names.

## Decision

### Pinned version

OpenTelemetry semantic conventions **v1.41.1** (tag `v1.41.1`, commit
`ead83b9b0fa36540c1642fce46e874f002ac23f1`), schema URL `https://opentelemetry.io/schemas/1.41.1`, source
`model/gen-ai/registry.yaml`. All `gen_ai` attributes there are `development` stability. Moving to a different
version needs a new ADR that supersedes this one.

### Mapping

| CostEntry field       | Attribute                                  | Type    | Rule                                                                                                                    |
| --------------------- | ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ts`                  | not exported                               | —       | Span timing belongs to the span model, which is out of scope here                                                       |
| `issue`               | `factory.issue`                            | string  |                                                                                                                         |
| `task`                | `factory.task`                             | string  | Not `gen_ai.operation.name`; factory tasks are not its well-known values                                                |
| `model`               | `gen_ai.request.model`                     | string  | The model the factory routed the call to. `gen_ai.response.model` is not set from CostEntry                             |
| `inputTokens`         | `gen_ai.usage.input_tokens`                | int     | Includes cached tokens, as upstream says it SHOULD                                                                      |
| `outputTokens`        | `gen_ai.usage.output_tokens`               | int     |                                                                                                                         |
| `cost`                | `factory.cost.usd`                         | double  | Omitted when the row is unpriced (see Unpriced rule)                                                                    |
| `unpriced`            | `factory.cost.unpriced`                    | boolean | See Unpriced rule                                                                                                       |
| `failoverReason`      | `factory.failover.reason`                  | string  | A `FailoverReason` value; omitted when absent                                                                           |
| `retryCause`          | `factory.retry.cause`                      | string  | `checker`, `failover`, `timeout` or `other`; omitted when absent                                                        |
| `estimated`           | `factory.usage.estimated`                  | boolean | true = character-count heuristic tokens; omitted when absent                                                            |
| `rawInputTokens`      | not exported                               | —       | Derivable as input_tokens − cache_read − cache_creation; exporting it invites double counting                           |
| `cacheReadTokens`     | `gen_ai.usage.cache_read.input_tokens`     | int     |                                                                                                                         |
| `cacheCreationTokens` | `gen_ai.usage.cache_creation.input_tokens` | int     | The v1.41.1 name. The unreleased genai repo renames it `cache_write`; adopting that needs a superseding ADR             |
| `numTurns`            | `factory.agent.turns`                      | int     |                                                                                                                         |
| `durationMs`          | `factory.duration.cli_ms`                  | int     | CLI-reported wall-clock ms                                                                                              |
| `durationApiMs`       | `factory.duration.api_ms`                  | int     |                                                                                                                         |
| `sandboxRuntime`      | `factory.sandbox.runtime`                  | string  |                                                                                                                         |
| `duration`            | `factory.duration.router_ms`               | int     | Router-measured ms. Kept in ms as an attribute; no conversion to the seconds used by `gen_ai.client.operation.duration` |
| `reworkRoundCount`    | `factory.rework.round_count`               | int     |                                                                                                                         |
| `workspaceBackend`    | `factory.workspace.backend`                | string  | `worktree` or `disposable-docker`                                                                                       |

**Provider (derived, not a CostEntry field)** maps to `gen_ai.provider.name`, set from the provider the factory
routed the model to, using the v1.41.1 well-known values (e.g. `anthropic`, `openai`, `deepseek`) where one
applies. It is omitted when the provider cannot be determined. `gen_ai.system` is never set.

### Rules

- Every CostEntry field maps to exactly the one attribute in the table, or is not exported. No other attribute
  names are emitted for CostEntry data.
- An optional field that is absent on the row is omitted. It is never defaulted to 0, false or "".
- Deprecated names (`gen_ai.system`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`) are never
  emitted.
- Adding a field to `CostEntry` requires a new ADR that supersedes this one and adds the field's row.

### Unpriced rule

A row is unpriced when `unpriced` is true, or `cost` is null or missing (the same test `aggregateCosts` in
`packages/core/src/usage/index.ts` uses). An unpriced row omits `factory.cost.usd` and sets
`factory.cost.unpriced=true`. Its cost is never exported as `0`, consistent with ADR-0020. A priced row sets
`factory.cost.usd` to its cost and `factory.cost.unpriced=false`. A priced cost of exactly 0, for a model with a
known zero price, is exported as 0 because it is a real price, not missing data.

## Consequences

- Positive: one source of names, backends can query cost safely, and unknown cost stays unknown.
- Negative: the `gen_ai` names are `development` stability and the cache_creation name is expected to change, so a
  re-pin needs a superseding ADR.
- Span tree, IDs, export model and backend choice are left to later ADRs (#1968). `gen_ai.operation.name` is not
  decided here.

References: #1985, parent #1968, spike #1983 (docs/research/otel-genai-semconv-attributes.md), ADR-0020.
