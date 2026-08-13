# ADR-0020: Cost KPIs are scored on cost-bearing cohorts, and absent cost data is unknown, never zero

- Status: Accepted
- Date: 2026-08-13

## Context

`computeHealthKpis` reported `costPerMergedPr` as `totalCost / merged`. With no
`.factory/costs.jsonl` — the normal state before harness cost capture (#424, #425, ADR-0019)
— `totalCost` is `0`, so the report rendered a confident `$0.0000`: a missing number
disguised as an excellent one, which is the fastest way to lose a skeptical reviewer's trust
in every other figure on the page. Two denominators had to be settled to fix it. First, which
runs cost-per-merged-PR is scored over: dividing all spend in the window by the merged count
charges non-merged runs' spend to merged PRs, while dividing by every merged run charges
merged runs that were never instrumented as if they were free. Second, what "coverage" is
measured against: the event log records phase executions, not individual model calls, and a
CHECK phase whose checkers are all deterministic (compile/tests/lint are commands, not models)
legitimately bills nothing — so a per-phase denominator would invent a coverage gap on
perfectly healthy runs. The one thing the log does record exactly once per uncosted model
call is the `failover` event: the router writes a cost row only on a successful `run()`, so
every failed attempt burns tokens and leaves a `failover` event and no row.

## Decision

Cost KPIs are scored on the cohort that can actually be scored, and report that cohort's size
alongside every figure. `costPerMergedPr` is the mean, and `medianCostPerMergedPr` the median,
of per-run cost totals over merged runs carrying at least one cost row; `costScoredMergedRuns`
carries that cohort's size, and both figures are `null` — never `0` — when it is empty. Cost
coverage is `costRows / (costRows + failover-event count)`: one known model invocation per
cost row plus one per burned attempt, bounded in [0, 1] by construction, and `null` when
neither is observed. Only `type === 'failover'` events count, because
`rework_model_failed` carries a `failoverReason` for the same attempts and would double-count.
`estimatedCostShare` is the share of `totalCost` from rows marked `estimated: true`, `null`
when there are no rows. `formatKpiLines` renders every cost figure with the coverage suffix
and renders "unknown" wherever the underlying cohort is empty, so the KPI report never prints
a dollar amount it did not measure. The existing `phaseCosts` field (#614) remains the single
PLAN/BUILD/CHECK/SHIP cost split — it is now printed rather than duplicated — and
`costByRoute` adds the codex/claude split next to it, bucketing by cost-row task first and
model family second, so the split answers "whose bill" rather than "which harness binary".

## Consequences

Positive: no cost figure can be read without its denominator; missing data is visibly missing;
a single runaway run no longer sets the headline figure alone; and cost-per-merged-PR stops
charging abandoned runs' spend to merged PRs. Negative: `costPerMergedPr` changes meaning, so
`.factory/kpi-history.jsonl` contains a one-time discontinuity and `computeKpiDrift` may flag
spurious drift for up to `KPI_DRIFT_WINDOW_SIZE * 2` snapshots after this lands. Coverage can
never reach 100% on a run that failed over, because the router only writes a cost row on
success — that is a truthful report of unmeasured spend, not a bug to paper over, and closing
it means recording cost for failed attempts, which is a separate change. `costByRoute`'s
model-family bucketing puts an OpenAI model that dispatches through the claude-cli harness
(`gpt-4.1-mini`) in the `codex` bucket, which is correct for spend attribution and wrong for
harness attribution; anything that needs the harness split must not read this field.

## References

- [Issue #426 — Report cost per merged PR from real cost rows, with coverage](https://github.com/on-par/software-factory/issues/426)
- [ADR-0011 — the size-gate KPI is a binary per-run score, with rate and mean on different denominators](./0011-the-size-gate-kpi-is-a-binary-per-run-score-with-rate-and-mean-on-different-denominators.md)
- [ADR-0012 — the post-merge defect rate is scored on a delayed, window-closed cohort](./0012-the-post-merge-defect-rate-is-scored-on-a-delayed-window-closed-cohort-not-on-all-runs.md)
- [ADR-0019 — the codex harness reads token usage from `codex exec --json`](./0019-the-codex-harness-reads-token-usage-from-codex-exec-json-trading-away-the-stderr-model-banner.md)
