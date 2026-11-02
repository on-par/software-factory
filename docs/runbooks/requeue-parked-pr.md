# Requeue a parked issue that still has an open PR

When a lane parks an issue (for example `ci-failed`) after opening a draft PR, the PR and its branch stay open on GitHub. A requeue continues on that PR instead of opening a second one (#2253).

## Steps

1. Read the park comment on the issue and the CI result on the PR.
2. Fix what blocks the run (edit the issue, rebase, etc.). Editing the title is fine: the PR is matched by issue number, not by title.
3. Remove `factory:parked` and add `factory:queued`. Optionally run `factory reset <n>` first: it deletes local worktrees and branches only, never the remote branch or the PR.

## What the next claim does

| Open factory PRs for the issue (`<prefix>/<n>-*`, configured prefix, same repo) | Result                                                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Exactly one                                                                     | Adopts its head branch and logs `pr-adopted` (PR number, branch, head SHA). BUILD/SHIP push to that PR.           |
| Two or more                                                                     | Parks as `escalate` before any worktree exists and logs `pr-adopt-ambiguous`. Close all but one PR, then requeue. |
| None                                                                            | Fresh branch from `origin/main`, as before.                                                                       |
| Lookup fails                                                                    | Warns with `pr-adopt-lookup-failed` and uses the fresh branch.                                                    |

Resume, local-only, slice and stack runs keep their own branch selection and skip the lookup.

## Notes

- A requeue is a new claim, not a CI re-run. CI runs again only after BUILD/SHIP pushes a new commit (#1882); failed security jobs are never re-run without one.
- The CI rework caps from #2252 still apply on the adopted run.
- To re-run CHECK and rework on a PR's branch without touching labels, comment `/factory iterate` on the PR; see [iterate-pr-comment.md](./iterate-pr-comment.md).
