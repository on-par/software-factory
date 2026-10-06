# ADR-0122: An unpriced model call is recorded as `cost null, unpriced true`, and cost totals exclude and count it

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0020 settled that absent cost data is unknown, never zero, for the KPI report. The per-call cost path still broke that rule. `ModelRegistry.estimateCost` returned 0 for a model that is not in the registry, the router wrote that 0 into `.factory/costs.jsonl`, and `aggregateCosts` summed `cost ?? 0`. Once a 0 is on disk, nothing downstream can tell "this call was free" from "we had no price", so every cost view (TUI Costs tab, `factory cost`) printed a precise dollar figure that was never measured. The fix has to live in the persisted row format, because costs.jsonl is append-only and read by several consumers, and it must keep already-written rows readable.

## Decision

`ModelRegistry.estimateCost` returns `null` when the model is not registered. A registered model priced at 0 is genuinely free and still returns 0. A cost row whose dollar amount is unknown is written as `cost: null` with `unpriced: true`. A harness-reported `costUsd` always takes precedence. `CostEntry.cost` is `number | null`.

`aggregateCosts` treats a row as unpriced when `cost` is null or undefined or `unpriced` is true. It leaves those rows out of every dollar sum, still counts their tokens and tasks, and reports `unpricedCount` on each model, issue and total row. A model, issue or total `cost` is `null` only when it has unpriced rows and no priced rows. Display surfaces render costs through `formatCostTotal`, which prints "unknown" for `null` and appends "(N unpriced)" when N > 0. New cost readers must not coerce a null cost to 0 in a figure they present as a measured total.

## Consequences

An unpriced model can no longer pass for free, and a mixed total shows its real priced spend and states how many calls it could not price. Rows written before this change keep aggregating to the same figures, because they always carry a finite number. Historical rows that recorded 0 for an unknown model stay indistinguishable from free calls, so the fix only applies going forward. Every `CostEntry.cost` reader must now handle `null`. Budget and benchmark sums (`issueSpend`, the benchmark manifest `totalUsd`) still count unpriced calls as $0 of spend, so those figures are lower bounds whenever unpriced rows exist.

References: [issue #1738](https://github.com/on-par/software-factory/issues/1738), ADR-0020.
