# Re-run CHECK on a factory PR with `/factory iterate`

Post a `/factory iterate` comment on an open factory PR to make the factory re-run CHECK and its rework loop on that PR's existing branch. Use it for a PR that is parked or nearly green, instead of hand-editing labels ([requeue-parked-pr.md](./requeue-parked-pr.md)) or opening a new issue. Fixes are pushed to the same PR. It never opens a new PR or branch (#3625).

## Command

The first non-blank line of the comment must be exactly `/factory iterate`. Case and surrounding whitespace do not matter. Anything else is ignored: trailing words (`/factory iterate now`), a quoted reply (`> /factory iterate`), a command on a later line, or one inside a code fence. The factory's own receipts start with `Factory iterate:`, so they are never read as commands.

## What happens

1. `factory run` (or the daemon) polls open same-repo factory PRs (`<prefix>/<n>-*`) before each claim and finds the comment.
2. The PR's issue is queued on its lane label. If it was parked, `factory:parked` is removed. The factory replies with a `Factory iterate: queued …` receipt.
3. The next claim skips PLAN and BUILD, runs CHECK with the rework loop on the PR head branch, and ships to the same PR.

## Guards

- **Run in progress.** If the issue carries `factory:in-progress`, nothing is queued and no second claim is made. The factory posts one `Factory iterate: rejected — a run is already in progress` receipt. Comment again after the run finishes.
- **One lane label.** The issue needs exactly one `factory:lane:*` label. With none or several, the factory posts a rejected receipt naming the reason.
- **Closed PRs.** Only open PRs are scanned, so a comment on a closed PR does nothing.
- **Closed or retargeted at run time.** If the PR closes or its head changes between queueing and the run, the run fails with a `ReviewReworkError` before CHECK. Nothing ships and no new PR is opened.
- **Once per comment.** Each comment id is handled once (state in `state/iterate.json`). If several trusted comments are pending on a PR, the newest one is acted on.

## Authorization

The commenter must pass the same trust check as design approval (ADR-0128): they must be listed in `intake.trustedApprovers` when that list is set, otherwise they must be a repo admin. Comments from anyone else are silently ignored. There is no receipt.

## Requirements and rollout

- Needs `factory run` or the daemon on the GitHub queue. `--local-queue` runs do not poll.
- When the feature first rolls out, old `/factory iterate` comments from trusted actors on open factory PRs are honoured once each.

## Relation to review rework

[Review rework](https://github.com/on-par/software-factory/issues/3563) reacts to a trusted `CHANGES_REQUESTED` review and reworks that review's comments. `/factory iterate` reacts to a comment and only re-runs CHECK, with its own rework loop. If both are pending for an issue, the review rework is claimed first and the iterate record stays pending for a later run.
