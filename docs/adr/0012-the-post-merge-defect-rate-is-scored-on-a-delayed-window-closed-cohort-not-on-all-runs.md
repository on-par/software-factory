# ADR-0012: The post-merge defect rate is scored on a delayed, window-closed cohort, not on all runs

- Status: Accepted
- Date: 2026-08-10

## Context

Every existing rate in `HealthKpis` divides by `runs` — all issues the factory
attempted — and ADR-0011 made that convention explicit for the size gate: rates use
`runs`, means use their own cohort. `postMergeDefectRate` (#612) cannot follow it. The
metric asks a question that is unanswerable until time has passed: "did what this run
merged hold up for 14 days?" A run that merged yesterday has no verdict, and a run that
never merged has no PR to watch. Dividing by `runs` would mix three populations —
scored, not-yet-scorable, and never-scorable — into one number that drifts downward
every time the factory ships another PR, so a busy week would read as a quality
improvement. The issue itself puts synchronous recording explicitly out of scope: the
rate is to be recorded "with a delay once the window has closed".

A second force: `computeHealthKpis` is pure aggregation over events plus cost rows,
with no clock and no I/O. Deciding whether a window has closed inherently needs "now",
and deciding whether a defect occurred needs the GitHub API. #420 already solved the
same shape for human-intervention KPIs by reconstructing synthetic `human-*` events
from an injected GitHub port and feeding them through the same event pipeline, leaving
the aggregator clock-free. Repeating that seam here costs nothing and keeps the one
function every KPI depends on trivially testable.

## Decision

The post-merge defect cohort is the set of merged factory runs whose defect window has
already closed at report time, and nothing else. `postMergeDefectRate` is
`postMergeDefectRuns / defectWindowClosedRuns`, and it is `null` — never `0` — when
that cohort is empty, so "no verdict yet" is never rendered as "no defects".
`HealthKpis` carries `defectWindowClosedRuns` alongside the rate, and
`kpisToHistoryRecord` writes both into every `kpi-history.jsonl` row, so a historical
rate can always be read against the denominator it was computed on.

Window closure and signal detection live outside the aggregator.
`packages/core/src/kpis/defects.ts` owns an injected `DefectSourceClient` port and a
pure `detectPostMergeDefects(sources, logEvents, opts)` that takes `now` and
`windowDays` explicitly and emits synthetic `defect-window-closed` and
`post-merge-defect` `FactoryEvent`s. It emits those events only for PRs whose window
has already closed: a signal observed against a still-open window is deliberately
dropped, not buffered, because the run is not yet scorable. `computeHealthKpis` keeps
its exact `(events, costs)` signature and simply counts the two event types, exactly as
it counts `merged`, `rework`, and `human-*`. The window length defaults to 14 days and
is configured by `kpis.defectWindowDays` in `factory.json`, overridable with
`FACTORY_DEFECT_WINDOW_DAYS` through `resolveDefectWindowDays`.

## Consequences

Positive: the number means what it says — among runs old enough to judge, this share
went bad. It is stable against shipping volume, it cannot be gamed by merging more
PRs, and the denominator travels with it in history. The aggregator stays pure and
clock-free, so the whole KPI surface remains testable with plain event arrays.
Changing the window is a config edit, not a code change.

Negative: `postMergeDefectRate` is deliberately NOT comparable to `mergeRate`,
`reworkRate`, `stuckRate`, or `sizeGateEscalationRate` — it is the one rate in
`HealthKpis` on a different denominator, and anyone adding a KPI must now decide which
convention applies rather than following one rule. The metric also lags reality by a
full window: a defect shipped today is invisible for 14 days, and shortening the
window to see it sooner trades away exactly the detection coverage the window exists
to buy. Because a still-open window emits nothing, a signal seen early is re-derived
from GitHub on a later run rather than remembered — correct, but it means the GitHub
history must still contain the signal when the window finally closes.

## References

- [ADR-0011 — The size-gate KPI is a binary per-run score, with rate and mean on different denominators](0011-the-size-gate-kpi-is-a-binary-per-run-score-with-rate-and-mean-on-different-denominators.md)
- [Issue #612 — kpis: track post-merge defect rate per factory run](https://github.com/on-par/software-factory/issues/612)
