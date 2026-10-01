# ADR-0127: A classifier backtest writes only its own file, lets hand labels override outcome facts, and fails closed on unpriced spend

- Status: Accepted
- Date: 2026-10-01

## Context

Shadow classification (ADR-0121, ADR-0124, ADR-0125, ADR-0126) builds a track record slowly, so #1728 adds a backtest over historical merged factory PRs. Three things about that backtest are not obvious from the code. First, its verdicts are retrospective: the plan, issue and ADRs it reads can postdate the decision, so they are not evidence of the same quality as live shadow verdicts. Second, its outcome labels come from regex heuristics (reverts, back-references, concern comments), and humans need to be able to correct them. The report, though, buckets by outcome facts rather than by a "true class". Third, its model spend is real money gated by `--max-cost`, while ADR-0122 says an unpriced call has unknown cost.

## Decision

`runClassifierBacktest` (`packages/core/src/kpis/classifier-backtest.ts`) produces `ClassifierOutcomeRecord`s by synthesizing a `pr-classified` event per PR and calling `joinClassifierOutcomes`, so ADR-0125's agreement rule stays single-owner. The CLI writes them only to `.factory/state/classifier-backtest-<timestamp>.jsonl`, never to `classifier-outcomes.jsonl` or `events.ndjson`. Backtest records are not shadow evidence for promoting a class under ADR-0121.

A hand label (`--labels` CSV `pr,class`) overrides the heuristic outcome facts through `applyHandLabel` in `classifier-outcomes.ts`. Label A means the PR merged clean: no defect, no human edit, no abandonment. Label B or C means the PR needed a human, which is recorded as a defect. Either way the defect window counts as closed. The verdict and slip are then recomputed by the same `decideVerdict`, and the original heuristic facts are kept on the record.

With `--max-cost`, the run stops before the next PR once priced spend reaches the budget, and it also stops after any classifier call whose cost is unpriced (`costUsd: null`).

## Consequences

The live shadow track record stays uncontaminated, and the backtest report reuses the exact ADR-0126 math. Hand labels are coarse: they say whether a PR needed a human, not which of B or C it needed. A repo whose classifier model is unpriced cannot run a budgeted backtest until the model is priced. Backtest results can be optimistic because of hindsight in the inputs, so they can justify an early kill but never a promotion.

References: ADR-0121, ADR-0122, ADR-0125, ADR-0126, issue #1728.
