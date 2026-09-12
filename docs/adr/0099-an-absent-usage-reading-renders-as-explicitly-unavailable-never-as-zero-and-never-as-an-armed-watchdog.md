# ADR-0099: An absent usage reading renders as explicitly unavailable, never as zero and never as an armed watchdog

- Status: Accepted
- Date: 2026-09-12

## Context

The factory app's run overview needs to show usage headroom during a run (#1386,
epic #1377). The engine already treats "no usage reading" as a first-class state
rather than an error: `watchUsage` in `packages/core/src/usage/index.ts` emits a
`usage-unavailable` event whose message says the watchdog is idle, because
`readUsage` returns `null` when the real Anthropic subscription signal is
unavailable and the list-price estimator is not opted in
(`FACTORY_USAGE_ESTIMATOR=1`). The UI can therefore be handed a reading, or
nothing at all, and the difference is operationally load-bearing: a watchdog with
no signal is not gating the run.

Two renderings of "nothing at all" are tempting and both lie. Substituting a
synthesized `0%` reading reads as maximum headroom. Rendering an empty or absent
panel reads as "usage is fine, the watchdog has it covered". This repo has already
decided this class of question twice in the other direction — ADR-0012 (a
post-merge defect rate with an empty cohort is `null`, never `0`) and ADR-0020
(absent cost data is unknown, never zero) — and the present decision extends that
family to the progress visuals, where the misreading is made by a human at a
glance rather than by a report generator.

The slice is also deliberately thin: the dashboard has no usage feed yet (the
server relays only lane lifecycle frames, and factoryd exposes no usage route), so
the panel takes its reading as an injected prop. That makes the null case the app's
actual production state today, not a theoretical edge, which is precisely why its
rendering has to be decided rather than improvised.

## Decision

The dashboard's usage-headroom panel takes `UsageHeadroomReading | null` as an
injected prop and owns the distinction itself. `toUsageHeadroomView`
(`packages/dashboard/src/usageHeadroom.ts`) maps `null` to
`{ available: false, reason: USAGE_UNAVAILABLE_REASON }`, and
`UsageHeadroom` renders that reason — which states in words that the usage
watchdog is not gating the run — with no percentage, no cap, and no
`role="progressbar"` element. Only a real reading renders the progressbar and the
percentage / cap / source / next-poll fields, and the rendered source label always
names which signal the percentage measures (subscription plan limit vs list-price
estimate).

No caller may substitute a default, zero, or last-known reading for a missing one:
any future usage feed — a factoryd route, an SSE frame, or a poll — must pass
`null` when it has no current reading, and must not fabricate one. The cap is
displayed alongside the source, never as the sole framing of the number.

## Consequences

Positive: the overview can never imply headroom or an armed watchdog it has no
evidence for; the unavailable state is testable and is asserted by name; any future
feed inherits a settled contract and needs no UI redesign; the rule now matches
ADR-0012 and ADR-0020 so the codebase reads consistently.

Negative: every producer of a reading carries the `| null` branch forever, and
every consumer pays one extra branch plus its test under the dashboard's 99%
coverage threshold. Until a feed lands, the shipped overview shows the unavailable
state permanently, which is honest but looks unfinished. The panel also cannot show
a stale-but-recent reading as "last known" without a future amendment to this
decision, since that would be a third state this ADR does not admit.

## References

- [Issue #1386 — Progress visuals: usage and cost progress are visible during runs](https://github.com/on-par/software-factory/issues/1386)
- [ADR-0020 — Cost KPIs are scored on cost-bearing cohorts, and absent cost data is unknown, never zero](https://github.com/on-par/software-factory/blob/main/docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md)
