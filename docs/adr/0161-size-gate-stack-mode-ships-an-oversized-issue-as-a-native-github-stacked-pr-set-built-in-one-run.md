# ADR-0161: Size-gate stack mode ships an oversized issue as a native GitHub stacked PR set built in one run

- Status: Accepted
- Date: 2026-10-13
- Supersedes: ADR-0043, ADR-0147, ADR-0156 (stack is the only size gate mode; file and slice are deprecated aliases for stack, #3835)
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
Stack is now the default and the only splitting mode; `off` is the only other mode, and `file` and `slice` are deprecated aliases for `stack` (#3835).

### One-run stack engine

One `run-issue` run builds every pending slice in order under one run lock (`packages/core/src/run/stack-engine.ts`,
`enterStackSlice` in `stack-slice-entry.ts`). Slice 1 bases on `--base-branch` or trunk, and each later slice bases on the
previous slice's PR head. The first failed or parked slice stops the stack.

### Slice plan

`stack` uses the same decomposition and the same slice-plan comment as `slice` (ADR-0147, ADR-0156): INVEST stories
with Gherkin acceptance criteria, in build order, capped by `sizeGate.maxSlices`. Each checklist item also records the
slice's branch and, once opened, its PR number. The comment is still the only record of slice state.

### One slice at a time, the whole stack in one run

- `factory run-issue --stack` builds every pending slice in order inside one run (#3798). Slice k is planned as
  soon as slice k-1's PR is open or merged, so no run waits on review. The lane (`factory run`) still builds one
  slice per run; its queue preflight claims the next slice when the PR below is approved or merged (see Queue).
- A merged slice below: the slice branches from `origin/main` and its PR targets `main`. An open slice below: the
  slice branches from slice k-1's branch and its PR targets that branch. Slice 1 uses `main` or `--base-branch`.
- CHECK diffs slice k against its parent branch, not `main`, and the CHECK baseline (ADR-0147's base comparison) runs
  on the parent branch's head.
- BUILD's no-diff check, CHECK and the review floor diff slice k against its parent branch
  (`parentBaseRef`, passed to `collectDesignDiff` as `baseRefOverride`). In stack mode this
  explicit parent base outranks the remote base refs (`origin/main`, `origin/master`) and the
  run-start HEAD fallback. If it does not resolve, the diff is skipped and never falls back to
  `main`. A slice with no changes beyond its parent parks as `no_diff` (#2717).
- Both size gates still apply to each slice. A slice is never sliced again.
- When slice k fails CHECK after rework, the issue parks and slices k to n are recorded as not built.

### SHIP opens one slice PR

- SHIP opens slice k's PR on `main` (k = 1, or the slice below merged) or on slice k-1's branch. It writes the
  stack-order line in the PR body and rewrites the parent PR's next pointer.
- PR titles end with `slice k/n (#<issue>)`. Slices 1 to n-1 say `Part of #<issue>`. Only the top slice says
  `Closes #<issue>`.

### Merging

Merges are bottom-up squash merges under the ADR-0144 trust tiers. After each squash merge the factory restacks
the open layers above it, model-free (`restackAfterSquashMerge`): `git rebase --onto origin/main <merged head>` for the
next layer and onto the new head of the layer below for higher ones, one atomic push leased on each layer's recorded
head, the next layer retargeted to `main`, and the new heads recorded in the slice plan. A conflict or lease failure
pushes nothing and parks the issue naming the slice, PR and files. The restack runs from the queue preflight's
`restack` decision and right after the lane's own layer merge. A rebased layer has a new head SHA, so its CI must pass again before ADR-0146 lets it merge. The factory's
auto-merge, where the tier allows it, merges the stack in order and never merges a layer whose lower layer is open.

### Queue

The queue preflight defers the issue while the top built slice PR waits for review. It claims the issue when that PR
is approved or merged (#3366). A non-final ready slice is released to `factory:queued`. A waiting slice is released,
never parked.

### Failure handling

- A slice fails CHECK after rework: the issue parks with slices k to n recorded `not-built` in the slice-plan comment.
- Review changes a lower slice (its PR head SHA differs from the one recorded when the factory opened it,
  `detectLowerSliceChange` and `parkOnLowerSliceChange` in `packages/core/src/phases/stack-review-change.ts`): the
  issue parks and the slice-plan comment names the affected upper slices. The factory does not rebuild them (#2674).
- A lower PR closes without merging: the issue parks and names the layers above it.
- An over-cap slice plan: recorded and parks, as in ADR-0156.

## Consequences

Each slice costs a full PLAN, BUILD, CHECK and SHIP round trip, and slice k+1 waits for a human to approve or merge
slice k. The trade-off is that review of a lower slice shapes the slices above it, instead of invalidating them.

Later slices are built on code that is not on `main` yet. When review changes a lower layer, the upper layers may no
longer fit. GitHub's rebase handles textual changes, and CI on each rebased layer catches the rest, but a semantic
change below can still leave an upper layer wrong in ways CI does not see. The first version parks the issue in that
case instead of rebuilding.

Changing the default mode to `stack`, or rebuilding upper layers automatically, needs a new ADR.

## Out of scope

- Making `stack` the default mode.
- Automatically rebuilding upper layers after review changes a lower layer.
- Re-slicing a slice.
- Cross-repository stacks.
- A dependency on the `gh stack` CLI extension.
- Changes to the ADR-0144 trust tiers or ADR-0146 SHA-pinned merges.
- Changing `file`, `slice` or `off` behavior.
