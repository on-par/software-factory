# Requeue an issue parked by a CI failure

When SHIP's CI watch fails, the run parks the issue as `ci-failed` and leaves its draft PR open on the factory branch. From #2253 the next claim of that issue continues on that PR instead of starting over.

## Steps

1. Read the CI evidence on the parked issue and the draft PR (failing checks, code-scanning alerts).
2. Remove the `factory:parked` label and add `factory:queued`.
3. The next lane that claims the issue adopts the stranded PR. It builds on top of the PR's head, pushes new commits to the same branch, and watches CI on the new head. No second PR is opened.

## What qualifies for adoption

All of these must hold, otherwise the draft parks as before ("PR #N is draft or its draft state is unavailable"):

- The issue's last park event in the lane's local `events.ndjson` is `ci-failed`.
- Exactly one open PR has a body saying `Closes #N`.
- That PR is a draft, its head is in this repository, and its head branch is a factory branch for issue N.

A lane that does not have the `ci-failed` event in its local events log (for example a different machine) parks the draft as before.

## Ambiguity

If two or more open PRs say `Closes #N`, the issue parks with `ambiguous: N open PRs close #N (#a, #b)` and nothing is built or opened. Close the extra PRs and requeue.

## A requeue needs a new commit

An adopted run that finishes with no new commit over the adopted head fails closed with a reason naming #1882. It does not push and does not re-run CI. Fix the failure on the branch (the brief carries the prior failing checks and alerts), then requeue.

## Related

- #2252: the in-run CI rework loop (not part of this change).
- #851
- #1882: CI must not be re-run without a new commit.
