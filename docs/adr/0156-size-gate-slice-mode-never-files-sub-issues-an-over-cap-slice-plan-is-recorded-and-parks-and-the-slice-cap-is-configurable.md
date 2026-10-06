# ADR-0156: Size-gate slice mode never files sub-issues; an over-cap slice plan is recorded and parks, and the slice cap is configurable

- Status: Accepted
- Date: 2026-10-06
- Amends: [ADR-0147](0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md) (replaces the more-than-5-slices fallback to `file`; makes the slice cap configurable)

## Context

ADR-0147 added `sizeGate.mode: slice`. In slice mode an oversized issue stays whole and ships as sequential slice PRs.
The slice plan is one comment on the issue, and the factory files no issues. One rule breaks that promise: when the
decomposition has more than 5 slices, the run falls back to `file` behavior for the gate that tripped.

- At the pre-flight gate, `file` behavior files child issues. `plan.ts` calls `publishDecomposition` with
  `fileSubIssues: true`.
- At the post-plan gate, `file` behavior parks, and `publishDecomposition` posts a "proposed epic" comment.

A real run showed the cost (`leantechniques/agent-ready-assessment#166`, 2026-10-06). The operator passed
`--size-gate slice` to keep the backlog small. The decomposition returned 6 stories. The run filed six child issues
(#218–#223), posted a proposal comment, failed, and told the operator to rerun with `--run-children`, which is a
`file`-mode flag. The operator chose slice mode to avoid exactly this, and the fallback overrode that choice when the
issue was biggest.

The cap of 5 is also fixed in code (`MAX_SLICES` in `packages/core/src/readiness/slice-plan.ts`). The operator cannot
raise it for one issue they know is large but sequential. ADR-0147 says a change to the slice cap needs a new ADR. This
is that ADR.

## Decision

### Slice mode never files issues

In `slice` mode, neither gate files an issue or posts a "proposed epic" comment. `file` mode is the only mode that
creates issues. ADR-0043 and ADR-0147 `file` behavior do not change.

When the decomposition has more slices than the cap, in either gate:

1. PLAN records the slice plan comment with every slice, exactly as for an in-cap plan. The marker stays
   `<!-- factory:slice-plan v1 -->`, and the comment format does not change.
2. The issue parks. The park reason names the slice count, the cap, and the flag that would accept the plan, for
   example: `slice plan has 11 slices (cap 10) — parked; rerun with --max-slices 11 or split the issue`.
3. PLAN logs `size-gate-escalated` with that reason. No child issue, no queue rewrite, no proposal comment.

A later run finds the recorded plan and reuses it. It does not decompose again. If the effective cap now covers the
plan, the run plans slice 1. If not, it parks again with the same reason.

The cap is checked only while every slice is `pending`. Once a slice has a PR or has merged, the plan runs to the end
whatever the cap is. Lowering the cap must not strand half-shipped work on `main`.

### The slice cap is configurable

- The factory config gets `sizeGate.maxSlices`, an integer from 1 to 20. The default is 10.
- `factory run-issue --max-slices <n>` overrides the config for one run. An invalid value exits 2 and names the
  flag, as an invalid `--size-gate` does.
- An invalid config value fails validation and names the key `sizeGate.maxSlices`.
- The slice plan schema accepts up to 20 slices, the hard ceiling, so that a plan recorded under a high cap still
  parses under a lower one.

The ceiling exists because the slice plan comment holds every story twice: once visible and once as base64 JSON. A
very large plan can pass GitHub's comment size limit. A plan that cannot be posted parks, as it does today.

### Help text says what each mode does

`factory run-issue --help` must say that `slice` never files issues, and that `--run-children` applies only to `file`
mode. The `sizeGate` entry in the config example says the same and documents `maxSlices`.

## Consequences

`--size-gate slice` now means what an operator expects: the backlog never grows from a size-gate trip. An issue that is
too big even for slicing parks with its slice plan on record. The operator can read the plan, then rerun with a higher
`--max-slices`, split the issue by hand, or rerun with `--size-gate file`.

The default cap rises from 5 to 10. More issues ship as slices without a human step. Each slice is still bounded by
both size gates, and a slice is never sliced again, so a higher cap does not make any single BUILD pass bigger. It does
mean more serial PRs, and under the T0 tier (ADR-0144) more human merges, for one issue.

An over-cap issue now costs one decomposition call and parks, where before it filed issues. The recorded plan means a
rerun pays no second decomposition call.

The two gates act the same in slice mode for over-cap plans too. ADR-0147 already made both gates follow one rule
for in-cap plans, and this extends it.

Changing the default cap or the ceiling needs a new ADR. Changing the default mode is still a config change.

## References

- [ADR-0043](0043-a-tripped-pre-flight-size-gate-files-sub-issues-under-the-original-issue-and-re-queues-them-the-post-plan-gate-still-parks.md),
  [ADR-0144](0144-merges-follow-a-t0-t1-t2-trust-tier-ladder-where-t0-human-merge-is-the-default-and-sensitive-paths-or-classifier-errors-fail-closed-to-t0.md),
  [ADR-0147](0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md)
