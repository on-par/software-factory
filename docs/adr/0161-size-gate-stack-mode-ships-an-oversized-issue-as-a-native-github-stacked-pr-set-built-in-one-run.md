# ADR-0161: Size-gate stack mode ships an oversized issue as a stacked PR set, one slice per run

- Status: Proposed
- Date: 2026-10-13
- Amends: [ADR-0147](0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md) (adds `sizeGate.mode: stack`; `slice` is unchanged and is the fallback)
- Issue: #2619

## Context

ADR-0147 added `sizeGate.mode: slice`. An oversized issue stays whole and ships as sequential slice PRs: each run
builds one slice from `main`, and slice k+1 starts only after slice k merges. ADR-0147 considered stacked PRs and
rejected them for one reason. Factory merges are squash merges that delete the branch, so after each merge every
remaining PR in a stack had to be rebased, and the factory had no logic to rebuild a stack. It said to revisit the
choice "if the repo adopts a tool that rebuilds stacks".

Sequential slices have a cost. An issue with n slices takes n full PLAN, BUILD, CHECK and SHIP round trips, one after
another. Under the default T0 tier (ADR-0144) a human merges every slice, so the issue also waits for n human
merges spread over hours. A reviewer sees one slice at a time and never sees the whole change.

GitHub now has native stacked pull requests (public preview on all repositories since 2026-07-31). A stack is an
ordered chain of PRs in one repository, each based on the branch of the PR below it, with the bottom PR on the trunk.
When the bottom PR merges, GitHub rebases the remaining branches and retargets the next PR to the trunk, and squash
merges are supported. Each PR shows a stack map. Existing review rules, checks and merge requirements still apply.
Stacks can be created through the API or UI; the `gh stack` CLI extension is optional. This is the tool ADR-0147 was
waiting for.

## Decision

`sizeGate.mode` gets a fourth value, `stack`. `factory run-issue --size-gate stack` overrides the config for one run.
The default stays `file`, and `slice` and `off` are unchanged.

### Slice plan

`stack` uses the same decomposition and the same slice-plan comment as `slice` (ADR-0147, ADR-0156): INVEST stories
with Gherkin acceptance criteria, in build order, capped by `sizeGate.maxSlices`. Each checklist item also records the
slice's branch and, once opened, its PR number. The comment is still the only record of slice state.

### One slice per run, after the slice below is approved or merged

- A run builds one slice and releases the issue to `factory:queued`. Slice k+1 starts only after a reviewer
  approves or merges slice k, so the review of slice k shapes slice k+1.
- The next claim picks the lowest pending slice whose lower slice is merged (branch from `origin/main`, PR on
  `main`) or pr-open and approved (branch from and target the lower slice's branch). Slice 1 is built on `main`.
- A waiting lower slice (open and not approved) releases the issue back to the queue and is never parked. The
  slice-plan comment shows `PR open #N — waiting for approval or merge before slice k+1`, and the run log names the
  PR.
- CHECK diffs slice k against its parent branch, not `main`, and the CHECK baseline (ADR-0147's base comparison) runs
  on the parent branch's head. A slice built on `main` after its lower slice merged diffs against `main`.
- BUILD's no-diff check, CHECK and the review floor diff slice k against its parent branch
  (`parentBaseRef`, passed to `collectDesignDiff` as `baseRefOverride`). In stack mode this
  explicit parent base outranks the remote base refs (`origin/main`, `origin/master`) and the
  run-start HEAD fallback. If it does not resolve, the diff is skipped and never falls back to
  `main`. A slice with no changes beyond its parent parks as `no_diff` (#2717).
- Both size gates still apply to each slice. A slice is never sliced again.
- When slice k fails CHECK after rework, the run stops building and the issue parks with slices k to n recorded as
  not built.

### SHIP opens one slice PR per run

- Each run opens one slice PR whose base is `main` or the lower slice's branch, with the marked stack-order line in
  the PR body.
- PR titles end with `slice k/n (#<issue>)`. Slices 1 to n-1 say `Part of #<issue>`. Only the top slice says
  `Closes #<issue>`.

### Merging

Merges are bottom-up squash merges under the ADR-0144 trust tiers. After each merge GitHub rebases the remaining
layers. A rebased layer has a new head SHA, so its CI must pass again before ADR-0146 lets it merge. The factory's
auto-merge, where the tier allows it, merges the stack in order and never merges a layer whose lower layer is open.

### Queue

The queue preflight defers an issue while the top built slice PR is neither approved nor merged. Once it is, the
issue can be claimed for the next pending slice (#3366).

### Failure handling

- A slice fails CHECK after rework: stop building. The issue parks with
  slices k to n recorded `not-built` in the slice-plan comment.
- Review changes a lower slice (its PR head SHA differs from the one recorded when the factory opened it,
  `detectLowerSliceChange` and `parkOnLowerSliceChange` in `packages/core/src/phases/stack-review-change.ts`): the
  issue parks and the slice-plan comment names the affected upper slices. The factory does not rebuild them (#2674).
- A lower PR closes without merging: the issue parks and names the layers above it.
- An over-cap slice plan: recorded and parks, as in ADR-0156.

## Consequences

A reviewer shapes each slice before the next one is written, and no slice is built on code nobody has approved.
The cost is one PLAN, BUILD, CHECK and SHIP round trip per slice, spread over the review time of the slice below.

Slices built on an approved but unmerged lower slice are on a branch that is not on `main` yet. When review changes
a lower layer, the upper layers may no longer fit. CI on each layer catches textual conflicts, but a semantic change
below can still leave an upper layer wrong in ways CI does not see. The first version parks the issue in that case
instead of rebuilding.

One run holds the lane for one slice only. An issue whose lower slice waits for review goes back to the queue and
does not hold the lane.

Changing the default mode to `stack`, or rebuilding upper layers automatically, needs a new ADR.

## Out of scope

- Making `stack` the default mode.
- Automatically rebuilding upper layers after review changes a lower layer.
- Re-slicing a slice.
- Cross-repository stacks.
- A dependency on the `gh stack` CLI extension.
- Changes to the ADR-0144 trust tiers or ADR-0146 SHA-pinned merges.
- Changing `file`, `slice` or `off` behavior.
