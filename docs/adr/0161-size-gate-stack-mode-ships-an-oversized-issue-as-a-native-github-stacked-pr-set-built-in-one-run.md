# ADR-0161: Size-gate stack mode ships an oversized issue as a native GitHub stacked PR set built in one run

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

### One run builds the whole stack

- Slice 1 is planned and built on `main`. Slice k (k ≥ 2) is planned and built on slice k-1's branch, so it can use
  what the earlier slices actually did.
- CHECK diffs slice k against its parent branch, not `main`, and the CHECK baseline (ADR-0147's base comparison) runs
  on the parent branch's head.
- Both size gates still apply to each slice. A slice is never sliced again.
- When slice k fails CHECK after rework, the run stops building. Slices 1 to k-1 still open as a shorter stack, and
  the issue parks with slices k to n recorded as not built.

### SHIP opens one native stack

- SHIP pushes every built branch and opens every slice PR at once, linked as one GitHub stack through the API. The
  bottom PR targets `main`. Each other PR targets the branch below it.
- PR titles end with `slice k/n (#<issue>)`. Slices 1 to n-1 say `Part of #<issue>`. Only the top slice says
  `Closes #<issue>`.
- When the stack cannot be created (API error, preview not enabled for the repository), the run falls back to `slice`
  mode for this issue, logs why, and opens only slice 1.

### Merging

Merges are bottom-up squash merges under the ADR-0144 trust tiers. After each merge GitHub rebases the remaining
layers. A rebased layer has a new head SHA, so its CI must pass again before ADR-0146 lets it merge. The factory's
auto-merge, where the tier allows it, merges the stack in order and never merges a layer whose lower layer is open.

### Queue

An issue in stack mode has several open PRs. The queue preflight defers the issue while any slice PR in its slice-plan
comment is open, as `slice` mode already does for one PR. When a lower PR closes without merging, the issue parks and
names the layers above it. The factory does not rebuild upper layers after review changes to a lower layer; that is a
later decision.

## Consequences

An oversized issue costs one build pass instead of n serial round trips, and reviewers see the whole change as small
layers at once. Human merges can happen back to back instead of one per run.

Later slices are built on code that is not on `main` yet. When review changes a lower layer, the upper layers may no
longer fit. GitHub's rebase handles textual changes, and CI on each rebased layer catches the rest, but a semantic
change below can still leave an upper layer wrong in ways CI does not see. The first version parks the issue in that
case instead of rebuilding.

One run holds the lane for the whole stack build, which is longer than one slice. The lane is released once the stack
is open.

Stacked PRs are a preview feature, and the API may change. `slice` stays the fallback, so a failure to create a stack
never strands an issue.

Changing the default mode to `stack`, or rebuilding upper layers automatically, needs a new ADR.
