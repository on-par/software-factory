# Queue prerequisite stacks

An issue that declares `Prerequisite: #B` (or `Depends on: #B`) used to wait for B to merge. When B has an **open factory PR**
(a same-repo `factory/<B>-…` branch), the GitHub-labels queue now builds the dependent issue X on it instead (#3916, ADR-0161
addendum).

## What happens

1. **Stack.** X builds from B's branch and opens a draft-or-ready PR whose base is B's branch. Its body names the stack
   (`**Stack:** #B PR #n (...), then #X`) and carries a `<!-- factory:prerequisite-stack ... -->` marker. X's claim is released
   to `queued`; it is not landed.
2. **B moves.** If B's PR gets new commits, the next queue pass rebases X onto B's new head (one leased force-push of
   `factory/<X>-…`, which re-runs CI) and updates the marker.
3. **B merges.** The next pass rebases X `--onto main`, dropping B's commits, retargets the PR to `main` and removes the
   marker. X is then adopted and landed like any other PR.
4. **B closes unmerged.** X parks held; the park comment names the prerequisite PR. Fix or reopen B, then re-queue X.
5. **Chains.** In A <- B <- C, C stacks on B. When A merges, B restacks onto main, then C restacks onto B's new head.

A stacked PR is never landed while its base is not `main`: preflight does not adopt it and `squashMergeAndDelete` refuses a
PR whose base starts with `factory/`.

## What does not stack

Prerequisites without an open factory PR, human or fork PRs, Linear and Jira prerequisites, and several open prerequisites that
are not on one chain all keep waiting as before. A human push to X's stacked branch makes the restack park instead of
overwriting it.

## Switch

`queue.stackOnOpenPrerequisite` in `.factory/config.json` (default `true`). Set `false` to wait for prerequisites to merge.
A non-boolean value is treated as `true`.
