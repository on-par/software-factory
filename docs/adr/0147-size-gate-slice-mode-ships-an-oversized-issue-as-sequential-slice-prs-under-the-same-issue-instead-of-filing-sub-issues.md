# ADR-0147: Size-gate `slice` mode ships an oversized issue as sequential slice PRs under the same issue, instead of filing sub-issues

- Status: Accepted
- Date: 2026-10-05
- Amends: [ADR-0043](0043-a-tripped-pre-flight-size-gate-files-sub-issues-under-the-original-issue-and-re-queues-them-the-post-plan-gate-still-parks.md) (adds `sizeGate.mode`; only `file` keeps ADR-0043's behavior)

## Context

PLAN has two size gates (ADR-0010, ADR-0043). The pre-flight gate trips on the issue body: more than 5 in-scope
items or more than 5 acceptance criteria. The post-plan gate trips on the frozen design artifact: more than 6 target
types, 8 signatures or 10 call edges. Per ADR-0043, a pre-flight trip files child issues and rewrites the queue, and a
post-plan trip parks the issue for a human.

This has three costs. Every pre-flight trip adds child issues to the backlog, and the parent stays open as an epic
shell. Every post-plan trip needs a human to cut the work up. And there is no override: `runIssue`
(`packages/core/src/run/run-issue.ts`) passes `enforceSizeGate: true` to `runPlan` on every run.

The gates exist to keep each BUILD pass bounded, not to make the backlog bigger. The factory can split the work
inside the pipeline instead. Three ways to deliver the internal pieces were considered:

1. **One PR, one commit per piece.** This is the simplest, but a human still reviews one large PR, and the squash
   merge flattens the pieces into one commit on `main`.
2. **Stacked PRs.** All pieces open at once, each PR based on the branch of the piece before it. Factory merges are
   squash merges that delete the branch (`squashMergeAndDelete`). After each merge, every remaining PR must be
   rebased, which moves its head SHA, so CI must pass again before ADR-0146 lets it merge. This needs new logic to
   rebuild and merge the stack in order. The queue also assumes one open PR per issue.
3. **Sequential PRs.** Each piece is built from `main` after the piece before it has merged. Every PR targets
   `main`, so there is no stack to rebuild.

## Decision

The factory config gets `sizeGate.mode`, with the values `file`, `slice` and `off`. The default is `file`.
`factory run-issue --size-gate <mode>` overrides the config for one run.

- **`file`** keeps ADR-0043 exactly: the pre-flight gate files child issues and rewrites the queue, and the
  post-plan gate parks.
- **`off`** skips both gates. The whole issue goes to BUILD in one pass.
- **`slice`** delivers the issue as sequential slice PRs (option 3 above), with the rules below.

### Slice plan

When either gate trips in `slice` mode, PLAN runs the decomposition pass (`decomposeOversizedIssue`) with
`fileSubIssues: false`. The stories, in build order, become the slices. PLAN logs `size-gate-sliced` instead of
`size-gate-escalated`.

The slice plan is one comment on the issue. The comment starts with the hidden marker
`<!-- factory:slice-plan v1 -->` and holds one checklist item per slice: its number, its title and its state
(pending, PR open with its number, merged). It also holds each slice's full story, so a later run can plan that
slice without decomposing again. This comment is the only record of slice state. The factory edits only this comment. It
never edits the issue body, and it files no issues.

- When the comment already exists, PLAN reuses it and does not decompose again.
- When the comment has the marker but cannot be parsed, the issue parks.
- When the decomposition has more than 5 slices, the work is an epic, not one issue. The run falls back to `file`
  behavior for the gate that tripped.

### One slice per run

Each run works on exactly one slice: the first slice that is not merged.

- PLAN plans that slice's story against the current `main`, and the frozen spec covers only that slice. So a later
  slice can adapt to what the earlier slices actually did.
- Both size gates apply to the slice. A slice that trips a gate parks the issue. A slice is never sliced again.
- BUILD, CHECK and SHIP run as usual on the slice.
- Slice 1 uses the normal branch, `<prefix>/<issue>-<slug>`, because the CLI creates the branch before PLAN and
  the slice plan does not exist yet. Slice k (k ≥ 2) uses `<prefix>/<issue>-s<k>-<slug>`, and the CLI reads the slice
  plan comment to pick it. Every slice PR targets `main`.
- The PR title ends with `slice k/n (#<issue>)`. Slices 1 to n-1 say `Part of #<issue>`. Only slice n says
  `Closes #<issue>`, so the issue closes when the last slice merges.
- After SHIP, the run records the PR number in the slice plan comment and releases the issue back to
  `factory:queued`. The lane is free while the slice PR waits for CI and a merge.

### Queue and resume

- The queue preflight (`preflightQueuedIssue`) defers an issue whose current slice PR is still open. It does not
  adopt or park it. It finds that PR by the number in the slice plan comment, because `findOpenPRForIssue` matches
  only `Closes #<issue>`.
- The factory trusts a slice plan comment only when the authenticated GitHub identity wrote it. A comment with the
  marker from anyone else is ignored.
- When the slice PR has merged, the next pickup marks the slice merged in the comment and starts the next slice.
- When the slice PR was closed without a merge, the issue parks.
- When a slice fails CHECK or CI, the issue parks as any run does. The slices that merged before it stay on `main`.

Merges stay squash merges under the ADR-0144 trust tiers. Each slice is one commit on `main`, and each slice passes
CHECK and CI on its own.

## Consequences

The backlog does not grow when an issue is too big. The issue keeps its own history, and the slice plan comment
shows how the work was split and how far it has got. Each PR is small enough to review.

The slices are serial. Slice k+1 does not start until slice k merges. Under the default T0 tier (ADR-0144), a human
merges every slice, so an issue with n slices needs n human merges. Releasing the lane between slices keeps that
wait from blocking other work in the lane.

`main` holds a partial change between slices. Each slice must leave `main` green and working. The decomposition
pass already checks each story for INVEST "independent" and "valuable", but that check reads only the story text.

In `slice` mode, the two gates now act the same. ADR-0043 asked any change to one gate to say why the other should
or should not follow. Here both follow, because the goal of both gates is a bounded BUILD pass, and slicing reaches
that goal without a human. The post-plan PLAN call is still spent, and its plan is not used. That is the cost of
slicing late.

Stacked PRs are not used. Revisit that choice if factory merges stop being squash merges, or if the repo adopts a
tool that rebuilds stacks.

Changing the default mode is a config change and needs no new ADR. Changing the slice cap, the marker format or the
rule of one slice per run needs a new ADR.

## References

- [ADR-0010](0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md),
  [ADR-0043](0043-a-tripped-pre-flight-size-gate-files-sub-issues-under-the-original-issue-and-re-queues-them-the-post-plan-gate-still-parks.md),
  [ADR-0144](0144-merges-follow-a-t0-t1-t2-trust-tier-ladder-where-t0-human-merge-is-the-default-and-sensitive-paths-or-classifier-errors-fail-closed-to-t0.md),
  [ADR-0146](0146-factory-merges-are-pinned-to-the-ci-verified-head-sha-and-a-head-moved-refusal-is-ci-unverified-and-never-retried.md)
