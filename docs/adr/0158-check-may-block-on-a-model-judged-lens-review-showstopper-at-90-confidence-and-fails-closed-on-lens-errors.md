# ADR-0158: CHECK may block on a model-judged lens_review showstopper at >= 90 confidence, and fails closed on lens errors

- Status: Accepted
- Date: 2026-10-06
- Narrows: [ADR-0113](0113-the-review-verdict-blocks-only-on-deterministic-checker-failures-and-unmet-non-advisory-criteria.md) (adds one model-judged blocking checker to CHECK; ADR-0113's verdict mapping is unchanged)

## Context

Today CHECK gates on deterministic checkers plus `design_smells`. A run can still reach a ready PR with a
merge-blocking defect: wrong behavior, an unmet acceptance criterion, or a security hole. A human then finds it in
review, which is the step the factory exists to remove.

The manual `/lens-review` skill finds these with three read-only lenses: Tech Lead, Security Engineer, and Product
Owner.

Epic #2229 and issue #2236 add the built-in `lens_review` checker (`LENS_REVIEW_CHECKER` in
`packages/core/src/phases/check.ts`). Issue #2238 gave it a stable stuck signature.

ADR-0113 says an agent checker's false positive must never block on its own. Letting `lens_review` FAIL sends work
back to rework and can park the run, so the two rules need an explicit relationship.

## Decision

- `lens_review` runs three lenses in parallel over the lane diff against `diffBase`. Each lens also gets the frozen
  spec, the constitution, and the accepted ADRs.
- Each lens returns zod-validated JSON showstoppers carrying a 0-100 confidence.
- Only showstoppers with confidence >= 90 are kept. They are deduped across lenses by `file:line` plus summary. Any
  kept showstopper makes the checker FAIL, which goes through the normal rework loop (`MAX_REWORK_ROUNDS = 3`, stuck
  detection by sorted `file:line` refs). After the cap the run parks with the showstopper list.
- Below 90, a finding is dropped. It is never shown to the rework worker and never blocks.
- The threshold is configurable. The default is 90.
- `lens_review` runs only after every other checker passes. Otherwise it is SKIP with the reason "waiting on
  deterministic checkers", and that SKIP never counts as a pass.
- `lens_review` is excluded from the baseline re-run (ADR-0140, ADR-0141, ADR-0142). It can never classify a run as
  `environment`.
- **Fail closed.** A lens that times out or returns malformed or invalid JSON makes `lens_review` FAIL, with a reason
  that names the lens. It never becomes SKIP, because a SKIP could ship a run nobody reviewed. This mirrors
  `runCustomChecker`.
- **Default.** On for `on-par/software-factory`, opt-in for other target repos until eval data on the false-positive
  rate exists. `FACTORY_LENS_REVIEW=0` turns it off, mirroring `FACTORY_DESIGN_SMELLS=0`. The per-repo switch is a
  factory config flag owned by the checker (#2236).
- **No PR in CHECK.** BUILD never publishes and SHIP alone opens the PR (ADR-0136, ADR-0138). So the in-CHECK lens
  review has no PR, no PR comments, no `gh pr` calls, and no `/code-review` skill. Its instructions are inlined in the
  prompt. This is why it differs from the interactive `/lens-review` skill.

## Relation to ADR-0113

ADR-0113 governs `computeReviewVerdict` (`packages/core/src/review/verdict.ts`) for `factory review`. Its mapping,
`DETERMINISTIC_CHECKERS`, and the rule that an agent checker caps a verdict at approve with comments are all
unchanged.

This ADR narrows ADR-0113's principle only for CHECK's rework gate before SHIP. There, one model-judged checker may
block, and only at >= 90 confidence.

It does not supersede ADR-0113, and ADR-0113's text is not edited.

Blocking here costs at most rework rounds and a park, not a rejected human-visible PR. A human can still override by
re-running with `FACTORY_LENS_REVIEW=0`.

## Consequences

Fewer defects reach review.

A false positive at >= 90 can cost up to 3 rework rounds and a park of a good run. This trade-off is accepted in
exchange for never shipping an unreviewed run.

It costs three more agent calls per CHECK round after the deterministic checkers pass.

Lowering the threshold, making lens errors SKIP, or turning it on by default elsewhere needs a new ADR that supersedes
this one.

## References

- Issues #2229, #2236, #2238, #2240
- [ADR-0113](0113-the-review-verdict-blocks-only-on-deterministic-checker-failures-and-unmet-non-advisory-criteria.md),
  [ADR-0136](0136-build-is-commit-only-on-every-route-by-default-and-only-build-publishfrombuild-lets-the-claude-route-push-and-open-a-pr-before-check.md),
  [ADR-0138](0138-build-never-publishes-and-ship-is-the-only-phase-that-pushes-the-lane-branch-or-opens-the-pr-unless-build-publishfrombuild-is-set.md),
  [ADR-0141](0141-a-rework-round-is-classified-as-environment-when-every-round-1-failing-checker-also-fails-on-the-base-sha-decided-before-the-rework-loop.md),
  [ADR-0142](0142-rework-drops-checkers-that-also-fail-on-the-base-sha-from-its-prompt-and-failure-signature-on-partial-overlap-unless-they-name-new-failing-tests.md)
