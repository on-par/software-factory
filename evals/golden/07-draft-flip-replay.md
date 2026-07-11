---
id: draft-flip-replay
expectedRoute: codex
replay: true
sourceIssue: 60
rubric:
  - Names packages/core/src/phases/ship.ts as the target
  - Addresses the draft-to-ready flip race before merge
---
# Avoid merging while a PR is still draft

> Never-retire failure replay (issue #60).

The SHIP phase marks a PR ready with the `markPullRequestReadyForReview`
GraphQL mutation in `packages/core/src/phases/ship.ts`, but the merge attempt
can race the draft-to-ready flip. The merge then fires while GitHub still
reports the PR as a draft.

```stub-output
---
route: codex
---
# Spec: Avoid merging while a PR is still draft (#0)
## Goal
Prevent SHIP from attempting to merge a pull request until GitHub has finished applying the draft-to-ready transition.
## Files / approach
Update packages/core/src/phases/ship.ts around the markPullRequestReadyForReview mutation and merge path. After marking the PR ready, re-query the pull request isDraft state until it is false, or otherwise gate the merge on a confirmed non-draft state before calling the merge mutation.
## Tests
Add or update focused SHIP phase tests for the draft-to-ready race, then run npm run test -w @on-par/factory-core.
## Non-goals
No merge-queue redesign and no changes to unrelated SHIP behavior.
```
