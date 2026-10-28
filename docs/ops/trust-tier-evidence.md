# Trust-tier evidence

`factory classifier report` (and `--json`, as the `tier` key) ends with a read-only
trust-tier section. Cite it in a promotion PR under ADR-0148.

## What it shows

- The configured tier and the four promotion criteria: coverage ratchet, mutation score
  vs floor per package, class-A human-intervention rate, and class-A slips bounded by the
  ADR-0126 rule of three.
- `eligible for`: the next tier, or `none`, with the unmet criteria listed.

## Where each input comes from

- Configured tier: `classifier.trustTier` in the repo config (T0 when unset).
- Coverage: `coverage-ratchet.json` at the repo root. Write it with
  `npm run coverage-ratchet -- --out coverage-ratchet.json` after `npm run test`.
- Mutation: `mutation-summary.json` at the repo root, from the #805 producer.
- Slips and human intervention: class-A records in `classifier-outcomes.jsonl`
  (merged PRs whose defect window has closed).

## Staleness

Coverage and mutation evidence older than 14 days is `unknown`.

## Default limits

Slip rate (or rule-of-three bound) at most 5%; human-intervention rate at most 20%.

## Unknown is unmet

Missing, stale or malformed evidence, a package with no mutation floor, and zero merged
PRs with a closed defect window all show `unknown`, never 0%. `unknown` counts as unmet.

## Read-only

The report never changes tiers. Promotion is a human-merged policy PR (ADR-0148).
