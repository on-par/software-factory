# ADR-0132: Feedback issues are deduplicated by a hidden PR-URL marker and re-runs comment, never edit

- Status: Accepted
- Date: 2026-10-02

## Context

`factory feedback <pr-url>` files a human review's findings through core's `fileBug`. Its
fingerprint includes the run time, so fingerprint dedup never matches and each re-run opened
a new issue. Operators re-run feedback as reviews continue. Issue #1853 requires a re-run for
the same PR to add a comment to the first issue rather than file a new one, and puts editing
or closing that issue out of scope. `fileBug`'s fingerprint bump path rewrites the body's
count marker and only comments "Recurrence #n", so it cannot carry new findings without
editing the issue. The marker format is persisted in GitHub issue bodies, so changing it
later strands every issue already filed.

## Decision

`fileBug` accepts an optional `prUrl`. When it is set, the created issue's body ends with the
hidden marker `<!-- feedback-pr:<prUrl> -->`, appended after rendering and capping like the
fingerprint markers. Before filing, `findIssueByPrUrl` (packages/core/src/filing/index.ts)
looks for the lowest-numbered open candidate issue carrying that exact marker. On a match,
`fileBug` posts the newly rendered, sanitized, fenced and capped body as one comment and
returns action `commented`. It never calls `updateIssue` on that path. Closed matches are
ignored. `runFeedback` always passes the canonical PR URL from `parseFeedbackPrUrl`. New code
that recognizes a feedback issue for a PR must use `findIssueByPrUrl` / `feedbackPrMarker`.

## Consequences

Re-running feedback for a PR keeps one open issue per PR, and each run's findings arrive as a
comment, so reviewers see the history in one place. The existing issue's title, body and
labels are never modified. Lookup depends on `listCandidateIssues`, which returns only
bug-labeled issues updated in the last 30 days (first page of 100). An older, untouched
feedback issue is missed and a new one is filed. A closed feedback issue also leads to a new
issue. The `feedback-pr:` marker is now a persisted format that must stay readable.

## References

- [Issue](https://github.com/on-par/software-factory/issues/1853)
