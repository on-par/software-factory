# ADR-0010: The readiness size gate re-implements the INVEST "small" rule inside core

- Status: Accepted
- Date: 2026-08-09

## Context

`checkInvest()` in `packages/product/src/decompose/invest.ts` already encodes the
"small" predicate for a proposed story: at most 5 in-scope items and at most 5 acceptance
criteria (`MAX_IN_SCOPE`, `MAX_ACCEPTANCE_CRITERIA`). Issue #605 asks the engine-side
readiness scorer (`scoreIssueReadiness()` in `packages/core/src/readiness/index.ts`) to
apply the same gate so a bloated issue no longer scores 100% factory-ready.

Reusing `checkInvest()` directly is not available. `@on-par/product` is a private leaf app
whose declared dependencies are `adr-kit`, `contracts`, and `repo-context`; the documented
dependency direction is `contracts ← core ← cli`, and core never imports product. Making
the published `@on-par/factory-core` depend on a private package would also break
publication. Independently, `checkInvest()` operates on a fully parsed `Story` from
`@on-par/contracts`, while the readiness scorer works on raw GitHub issue Markdown that has
only been split into sections — there is no `Story` at that point in the pipeline, and
manufacturing one just to size an issue would import the whole decomposition model into the
engine. Hoisting the two threshold constants into `@on-par/contracts` was the remaining
option, but #605 places `packages/product/src/decompose/invest.ts` out of scope.

## Decision

Core owns its own size gate. `packages/core/src/readiness/size.ts` defines
`MAX_IN_SCOPE_ITEMS = 5` and `MAX_ACCEPTANCE_CRITERIA_ITEMS = 5` and exports
`checkIssueSize()`, which counts Markdown list items in an issue's `In scope` section and
checkbox items in its `Acceptance criteria` section and reports the same violation wording
the INVEST rule uses (`too big: N in-scope items, M acceptance criteria`).
`scoreIssueReadiness()` calls it for `factory-task` bodies only. The two thresholds are
therefore deliberately duplicated across `packages/product/src/decompose/invest.ts` and
`packages/core/src/readiness/size.ts`; each file carries a comment pointing at the other,
and both must be changed together. Core must not take a dependency on `@on-par/product`.

The size verdict is reported as a distinct signal — `ReadinessInfo.sizeOk` plus
`ReadinessInfo.sizeReason` — and does not fold into `score`, `pass`, or `missing`, which
keep their field-presence meaning. Both fields are optional, because a `ReadinessInfo` is
persisted verbatim inside `FactoryEvent` records in `.factory/events.ndjson` and events
written before this change carry no size verdict (ADR-0002's additive-optional rule).

## Consequences

Positive: core stays free of a product dependency and of the `Story` model; the readiness
scorer keeps working on raw issue Markdown with no I/O; PLAN's existing `readiness` event
carries the size verdict into the event log and KPIs with no change to `plan.ts`; and
existing gates (`pass`-based enrichment, fast-path eligibility, `factory ready`) are
untouched, so this lands with no behavior change to the pipeline.

Negative: the 5/5 thresholds and the "too big" wording now live in two places and can drift;
the two implementations also measure different substrates (parsed `Story` fields versus
counted Markdown list items), so they can disagree at the margin on the same underlying
work. Nothing gates on `sizeOk` yet — it is a measurement signal until a follow-up issue
wires it into PLAN and the CLI, which is when the consumer-side edits deliberately excluded
from #605 become necessary.

## References

- [Issue #605 — readiness: wire INVEST scope gate into scoreIssueReadiness](https://github.com/on-par/software-factory/issues/605)
- [ADR-0002 — Structured logging via the existing event log](https://github.com/on-par/software-factory/blob/main/docs/adr/0002-structured-logging-via-event-log.md)
