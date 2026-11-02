# ADR-0170: Land syncs a behind PR onto current main and merges only a head CI-verified against it, behind strict branch protection

- Status: Accepted
- Date: 2026-10-23
- Implemented in: `packages/cli/src/cli/land-behind.ts` (`probeHeadBehindBase`, `MAX_LAND_SYNC_ROUNDS = 3`), `packages/cli/src/cli/land-pr.ts` (`landOpenPullRequest`: behind or BEHIND sync, bounded rounds, "base kept moving" refusal), `packages/cli/src/cli/base-hold.ts` (`evaluateBaseHold`: a moved SHA clears only on a green strict verdict)
- Issue: #3619

## Context

`landOpenPullRequest` (`packages/cli/src/cli/land-pr.ts`) syncs a PR with `origin/main` only when
`mergeStateStatus === 'DIRTY'` or preflight adopted it with `syncMain` (#3324). GitHub reports a
cleanly-behind PR as CLEAN unless strict branch protection is on, so land watches CI on a head built
against a stale base and merges it, pinned to that SHA (ADR-0146). The merge commit itself is never
checked against current main.

Two incidents on 2026-10-23 turned main red this way:

- #3598 (commit 73593236) pushed `internal.ts` over its max-lines ceiling.
- #3607 (c87b6c2) and #3608 (fe029d3) merged three minutes apart. #3608 removed
  `escalateAfterTierExhausted` while #3607's test still set it, so `static` failed with TS2353
  until #3612.

Related work: #1886 (ADR-0166 merge-main sync), #3324 (adopt DIRTY/UNKNOWN PRs with `syncMain`) and
#3245 (adopt or sync DIRTY PRs). None of them verifies the merge result against current main.

The base hold (`evaluateBaseHold` in `packages/cli/src/cli/base-hold.ts`) also clears with reason
`sha-changed` as soon as origin/main moves, so lanes claim on a new main SHA whose CI may still be
pending or red.

## Considered options

1. **Branch protection or merge queue only.** Strict protection makes GitHub refuse behind merges,
   but every such factory land would fail with a merge error instead of updating, and repos without
   the protection stay exposed. A merge queue builds its own `merge_group` commit, which conflicts
   with ADR-0146's pinned `sha` merge in `squashMergeAndDelete`, needs `merge_group` triggers on
   every required workflow, and is not available on every plan.
2. **Factory land only.** Human merges (T0 is the default merge tier, ADR-0144) and any other merge
   path still land on a stale base, and a race remains between the last ancestry check and the
   merge call that only a server-side gate closes.
3. **Both.**

Rebase plus force-push was also rejected: ADR-0166 superseded it for land sync.

## Decision

Choose **Option 3**: repo rule as the hard gate, factory land as the operator.

**Repo rule.** `main` branch protection sets `required_status_checks.strict: true` ("Require
branches to be up to date before merging"). This is an operator rollout step; the factory does not
change protection settings itself. It covers human and factory merges alike, and GitHub refuses a
behind merge server-side.

**Factory land, stale base.**

- Before the first CI watch, and again inside the land lock immediately before
  `squashMergeAndDelete`, land checks whether the PR head contains current `origin/main`: after a
  fetch, `git merge-base --is-ancestor origin/main <head>`, or the compare API `behind_by > 0`.
  `mergeStateStatus` alone is not enough because BEHIND is reported only under strict protection.
  When GitHub does report `BEHIND`, treat it like DIRTY.
- When the head is behind, land syncs with the ADR-0166 path (`syncDirtyPullRequest` →
  `syncLandBranch`: merge origin/main, ordinary non-force push) inside the short lock, outside CI
  waits (ADR-0037 invariants). It then re-watches CI on the synced head and merges only that SHA
  (ADR-0146).
- If main moves again during the watch, repeat. Sync rounds are bounded (proposed 3, matching
  `MAX_REWORK_ROUNDS`). Past the bound, land refuses: it parks `ci-unverified` with "base kept
  moving" and does not merge.
- A non-README conflict during sync parks as today. Conflict resolution is out of scope (#1877).

**Checks fail after the update.** The PR is not merged. Land throws `CiFailedError` as today.
Inside a run, `shipWithCiRework` (`packages/core/src/run/ci-rework-loop.ts`) applies the existing
budget (`resolveMaxCiReworkRounds`, default 2) and the ADR-0162 suppression guard, then parks
`ci-failed`. A standalone `factory land` parks `ci-failed`. No new park reason is added.

**Claim gating after main advances.** `evaluateBaseHold` no longer returns `claim` on `sha-changed`
alone. When origin/main moved off the held SHA, the hold is re-targeted to the new SHA. Claims
resume only when the strict code-health verdict (`requiredChecksVerdict`, the #3290
`baseHealth.checks` allowlist) is green on that SHA. A pending or failed lookup keeps holding,
matching today's fail-closed CI rule. An unknown origin/main still fails open, as today. The
`base-hold-cleared` event's `sha-changed` reason becomes a re-target event and `ci-green` becomes
the only clearing reason. `confirmedLocally` holds still clear only when origin/main moves, now
subject to the green check.

## Consequences

- Every landing makes the other open PRs behind, so each lane pays one extra sync and CI re-watch
  (10–20 min) at land time. Throughput drops and lands serialize. This is the price of a green main.
- One extra fetch or compare per land. The behind check must be repeated under the lock, otherwise
  the race reopens.
- Repos that do not enable strict protection still get the factory-side guarantee, but not for human
  merges.
- Implemented by slice (a) in `land-behind.ts` / `land-pr.ts` (#3654) and slice (b) in `base-hold.ts`.

## References

- ADR-0037, ADR-0144, ADR-0146, ADR-0162, ADR-0166
- Issues #3619, #3598, #3607, #3608, #3612, #1886, #3324, #3245, #1877, #3290
- GitHub docs: "Require branches to be up to date before merging"; "Managing a merge queue"
