# ADR-0146: Factory merges are pinned to the CI-verified head SHA, and a head-moved refusal is CI-unverified and never retried

- Status: Accepted
- Date: 2026-10-05

## Context

`landOpenPullRequest` watched CI by branch name and then merged without a SHA. Between the green verdict and
the merge there is a lock wait and up to five backoff retries, which can take more than a minute. A push in
that window was merged without any CI check. Only the merge call can close the window: GitHub accepts an
expected head SHA (`sha` on `pulls.merge`, `--match-head-commit` on `gh pr merge`) and refuses with 409 if the
head moved. The draft fix was on PR #1657 (commit 7b9a852).

## Decision

`landOpenPullRequest` (`packages/cli/src/cli/index.ts`) reads the PR head SHA with `pulls.get` before each CI
watch, watches CI on that SHA, and passes it to `squashMergeAndDelete`. `squashMergeAndDelete` is the only
factory code that merges a PR. It sends `sha` to `pulls.merge`, and `--match-head-commit` on the opt-in admin
path. When a verified SHA was passed, a merge refusal that `isHeadModifiedMergeError` matches (status 409 or
"Head branch was modified") throws `CiUnverifiedError` at once, with no retry, and the PR stays open. Only a
`skipCI` land merges unpinned, because it has no verified SHA. Admin merge resolution (`FACTORY_MERGE_ADMIN`,
`run.merge.admin`) is unchanged.

## Consequences

A late push can no longer reach main unchecked. Each land costs one extra `pulls.get` call. A push after green
now parks the run as `ci-failed` instead of merging, so an operator or a later land has to re-run it. If
GitHub's PR head lags right after a rebase force-push, the watch can target the old SHA and the merge then
fails closed with a 409, which is a rare extra park. Any new merge path must pass the verified SHA too.

This is consistent with ADR-0144: trust tiers decide whether to merge, and this decides which commit merges.

## References

- [GitHub REST — Merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
- [gh pr merge manual](https://cli.github.com/manual/gh_pr_merge)
