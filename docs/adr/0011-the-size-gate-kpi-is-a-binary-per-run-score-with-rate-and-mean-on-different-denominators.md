# ADR-0011: The size-gate KPI is a binary per-run score, with rate and mean on different denominators

- Status: Accepted
- Date: 2026-08-10

## Context

#605/#610 added an INVEST size verdict to `ReadinessInfo`, but it is a boolean
(`sizeOk`) plus a human-readable `sizeReason` — there is no numeric size score anywhere
in the codebase, and `sizeReason` is absent whenever the gate passes. #608 asks the KPI
layer for both a `sizeGateEscalationRate` and a `meanSizeScore` while putting every file
outside `packages/core/src/kpis/index.ts` out of scope, so the two metrics must both be
derived from that single boolean. Two forces pull against each other. Deriving a
continuous score by parsing counts out of `sizeReason` would couple the KPI layer to a
message format owned by `readiness/size.ts` and would still score every passing run
1.0, so it buys resolution only on the failing tail at the cost of a hidden contract.
Meanwhile, if both metrics are computed over the same cohort they are exact complements
and carry one bit between them. `kpi-history.jsonl` is append-only and rows are never
recomputed, so whichever definitions ship become permanent and any later change silently
makes old rows incomparable with new ones.

## Decision

The per-run size score is binary: 1 when `readiness.sizeOk === true`, 0 when it is
`false`. A run whose readiness event carries no `sizeOk` at all (logged before #605) has
no size verdict and is excluded from the size cohort entirely rather than being counted
as passing. `meanSizeScore` is the mean of those scores over the size-scored cohort and
is `null` when the cohort is empty. `sizeGateEscalationRate` divides the escalated-run
count by `runs` — all issues the factory attempted — matching the issue's
"escalated / attempted" wording and the denominator every other rate in `HealthKpis`
already uses. The KPI layer never parses `sizeReason`. These definitions are fixed for
the lifetime of `kpi-history.jsonl`; changing either denominator requires a new field
name, not a redefinition of these.

## Consequences

Positive: both metrics fall out of data already on the event log, with no change to
`ReadinessInfo`, `checkIssueSize`, or any event writer, and no coupling to a
human-readable string. The two denominators differ, so the pair genuinely reports two
things — how oversized the scored issues were, and how much of the whole backlog the
gate even saw. Legacy rows and legacy events keep parsing unchanged.
Negative: `meanSizeScore` has no resolution on _how far_ over budget an issue was — a
6-item issue and a 20-item issue score the same 0. `sizeGateEscalationRate` is diluted
by runs that carry no size verdict (fast-path runs, which return before the readiness
event is logged, and any run predating #605), so it reads low while the log is mostly
pre-#605; the report line prints both denominators to keep that visible. If a numeric
size score is ever added to `ReadinessInfo`, `meanSizeScore` cannot simply start using
it — a new field is required to keep history comparable.

## References

- [ADR-0010 — The readiness size gate re-implements the INVEST "small" rule inside core](https://github.com/on-par/software-factory/blob/main/docs/adr/0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md)
- [Issue #608 — kpis: track size-gate escalation rate in kpi-history](https://github.com/on-par/software-factory/issues/608)
