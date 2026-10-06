# ADR-0148: A merge trust tier is promoted only by a human-merged policy change on published evidence, and demoted at least one tier on any slip

- Status: Accepted
- Date: 2026-10-05

## Context

ADR-0144 defines the T0/T1/T2 merge trust tiers and eligibility. T0 is the default until a human-merged policy change moves a class up, and that ADR explicitly leaves how a class earns promotion and when it is demoted to a later ADR. This is that ADR.

ADR-0121 already uses the same pattern for classifier rollout stages: each promotion is a human-merged policy PR naming its owner, and one slipped defect demotes one stage. ADR-0126 makes `factory classifier report` publish slip evidence with the rule-of-three bound, and print "unknown", never 0%, when n = 0.

The forces: a clean streak on a small sample is weak evidence, and an agent must not argue its own promotion. Without written rules, tier changes are left to judgment.

## Decision

### Promotion

A class moves up one tier (T0 → T1, or T1 → T2) only when all of the following evidence holds and is published with the promotion:

1. **Coverage ratchet green.** `npm run coverage-ratchet` (`scripts/coverage-ratchet.ts`) passes on `main` at the promotion commit, and no threshold in `vitest.config.ts` was lowered.
2. **Mutation score at or above the published floor.** The mutation score (`npm run mutation`, Stryker) for the code in scope is at or above the floor published by #804/#805. If no floor has been published, the evidence is missing and the class cannot be promoted. This fails closed.
3. **Human-intervention and slip rate within bounds, using the rule-of-three (ADR-0126).** Both rates are read from the class's merged, window-closed PRs, the evidence count n of ADR-0126. With 0 events in n PRs, the bound is the rule-of-three 95% upper bound, min(1, 3/n), and that bound must be within the limit the policy states. If any events occurred, use the observed rate. An "unknown" rate (n = 0) is never within bounds. For example, 10 clean merges still read "≤ 30%", so a tight bound needs many PRs.

**Who can promote.** Promotion happens only through a human-merged policy change: a PR to the versioned policy that names the class, the from-tier and to-tier, the accountable owner (ADR-0121), and links to the evidence above. No agent, classifier, scheduled job or auto-merge path can promote a tier. The promotion PR itself is Class C, because it changes merge and review policy (ADR-0121 floor, ADR-0144 sensitive paths), so it always takes a human merge. Promotion moves one tier at a time.

### Demotion

- One slipped defect on a T1 or T2 merged PR drops that PR's class at least one tier (T2 → T1 or lower, T1 → T0). A slip is a defect attributed to the merged PR inside its defect window, which is the ADR-0126 "slipped defect" bucket.
- This mirrors ADR-0121's demote-on-slip, which demotes one rollout stage on one slipped defect.
- Demotion needs no evidence threshold and no wait for a human. It applies on the first slip. A human may demote further, but never less than one tier.
- A demoted class re-earns its tier only through a fresh promotion under the rules above. The evidence count restarts after the slip.
- On doubt, such as an unreadable slip record or an unknown tier, resolve to T0, consistent with ADR-0144 fail closed.

## Consequences

- Tier changes are auditable and rule-bound.
- The demotion asymmetry means one slip costs more than one clean merge earns.
- Promotion is slow, because the rule-of-three needs many PRs.
- Promotion is blocked until #804/#805 publish a mutation floor.
- A single slip can undo a long streak.
- Changing the evidence list or the demotion rule needs a superseding ADR.

## Related

- [ADR-0144](0144-merges-follow-a-t0-t1-t2-trust-tier-ladder-where-t0-human-merge-is-the-default-and-sensitive-paths-or-classifier-errors-fail-closed-to-t0.md) defines the tiers and eligibility.
- [ADR-0121](0121-a-pr-classifier-may-only-escalate-review-until-a-named-human-promotes-a-class-on-published-evidence.md) sets human-merged promotion and demote-on-slip for classifier stages.
- [ADR-0126](0126-the-classifier-report-bounds-slips-with-the-rule-of-three-over-merged-closed-window-prs-and-prints-unknown-never-0-percent-when-there-is-no-evidence.md) defines the rule-of-three bound and the "unknown" rule.
- Issues #804, #805 and #1989.
