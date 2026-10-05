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

A mapping alone does not stop the cost rollup, a span file writer and an exporter from building different
hierarchies, defaulting to different destinations, or including model content. Those decisions are recorded
below (#1988).

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

### Span tree

- There are three levels, always in this order: a **run** span (root, one per issue run), a **phase** span
  (child of the run span, one per phase execution) and a **model call** span (child of the phase span that made
  the call, one per model invocation, i.e. one per `CostEntry` row).
- The phases are `plan`, `build`, `check` and `ship`, matching `FailurePhase` in
  `packages/core/src/types/index.ts`.
- A phase that runs more than once (CHECK across rework rounds, or BUILD rework) gets one phase span per
  execution, all children of the same run span. Phase spans are siblings, never nested in each other.
- A model call span is always a leaf and always has a phase parent. A model call with no known phase is not
  attached to the run span directly. It is not exported as a span, so producers cannot invent a fourth shape.
- No other span levels are defined. Adding one needs a superseding ADR.
- The CostEntry attributes from the Mapping table go only on model call spans. Run and phase spans carry no
  `gen_ai.*` attributes.
- Span names are `factory.run`, `factory.phase` and `factory.model_call`. Phase spans carry the attribute
  `factory.phase` (string, one of `plan`, `build`, `check`, `ship`).

### IDs

| ID     | Attribute        | Type   | Carried on                      |
| ------ | ---------------- | ------ | ------------------------------- |
| Run id | `factory.run.id` | string | run, phase and model call spans |
| Issue  | `factory.issue`  | string | run, phase and model call spans |
| Lane   | `factory.lane`   | string | run, phase and model call spans |

- Every span at every level carries all three, so any single span can be filtered by run, issue or lane without
  walking to its parent. The values are identical on every span of one run.
- `factory.issue` is the attribute the Mapping table assigns to `CostEntry.issue`. The model call span sets it
  once, with no duplicate name. On run and phase spans its value comes from the run, not from a CostEntry.
- Run id is the factory's own id for one issue run, not the OTel trace id. The OTel trace id and span ids are
  generated per the OTel spec, and one run is one trace. Lane is the `IssueRunState.lane` value.
- An ID that is unknown is omitted, never set to "".
- These are span-level IDs from the run context, not CostEntry fields, so they do not change the Mapping table.

### Export model

- The first and default export model is **local JSONL**: one JSON object per finished span, one per line,
  appended to a file on the operator's machine under the factory state directory. Each line holds the span's
  name, trace id, span id, parent span id (absent for the run span), start and end time, and its attributes. The
  exact path and line schema are set by the implementing slice, not here.
- **OTLP/HTTP is opt-in.** It is off unless the operator explicitly enables it in config or env and gives an
  endpoint. With no opt-in, no span data leaves the machine. Enabling OTLP/HTTP does not turn off the local
  JSONL file. OTLP/gRPC and other protocols are not chosen.
- The OTLP/HTTP export uses the same span tree, IDs and attribute names as the JSONL file. The two routes never
  differ in content.
- **No telemetry backend is chosen.** This ADR names no collector, vendor or storage product. OTLP/HTTP sends to
  whatever endpoint the operator configures.

### Content privacy

- No prompt text, completion text, system instructions, tool call arguments or results, issue bodies, diffs, or
  other model input or output content is placed in any span attribute, span event or log record produced by the
  telemetry path, on either export route.
- The v1.41.1 content attributes and events (the opt-in message, instruction and tool call content that the
  `gen_ai` registry defines) are never emitted. There is no opt-in that turns content capture on. Adding one
  needs a superseding ADR.
- Spans carry only the attributes in the Mapping table, the IDs table, and `factory.phase`.

Changing the span tree, an ID attribute, the default export route, or the content-privacy rule requires a new
ADR that supersedes this one.

## Consequences

- Positive: one source of names, backends can query cost safely, and unknown cost stays unknown.
- Negative: the `gen_ai` names are `development` stability and the cache_creation name is expected to change, so a
  re-pin needs a superseding ADR.
- Positive: one hierarchy and ID set across the rollup, the file writer and the exporter. Telemetry is local by
  default and never holds model content, so enabling OTLP/HTTP cannot leak prompts.
- Negative: with no content, traces cannot be used to debug prompt quality (use the local raw logs, ADR-0131).
  Carrying all three IDs on every span repeats data. A model call without a phase is dropped from spans.
- Backend choice is still left to a later decision (#1968). `gen_ai.operation.name` is not decided here.

References: #1985, #1988, parent #1968, spike #1983 (docs/research/otel-genai-semconv-attributes.md), ADR-0020,
ADR-0131.
