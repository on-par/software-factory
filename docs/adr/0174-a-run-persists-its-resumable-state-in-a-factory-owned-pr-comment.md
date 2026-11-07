# ADR-0174: A run persists its resumable state in a factory-owned PR comment

- Status: Accepted
- Date: 2026-11-04
- Amended by: [ADR-0176](0176-the-factory-s-own-github-identity-covers-app-installation-tokens-and-own-comment-checks-match-that-exact-account.md) (GitHub App installation tokens resolve their identity; decision 3 now applies only to genuine identity failures)
- See also: [ADR-0130](0130-auto-filed-bug-evidence-is-stripped-of-hidden-content-and-fenced-longer-than-any-backtick-run-inside-it.md) (park-comment marker trust), [ADR-0168](0168-a-repo-reads-tickets-from-one-configured-tracker-and-a-workkey-string-replaces-the-numeric-issue.md) (WorkKey), issue #3909

## Context

On a disposable host `.factory/state` disappears with the container. A later run for the same issue forgets which reviews it handled, how many rework rounds it used and what spec it froze, so a review-rework cap can be reset by moving host. The open factory PR survives the host and a fresh clone can read it with only `GH_TOKEN`.

## Decision

1. **Storage.** One hidden comment on the open factory PR, found by `<!-- factory:run-state v1 key:<WorkKey> -->`. The body is a human line plus `<!-- factory:run-state-data <base64 JSON> sha256:<hex> -->`. `savePrRunState` reuses `upsertMarkerComment`, so it edits only the authenticated user's own comment.
2. **Trust.** A state block is trusted only when all hold: the comment author id equals the authenticated user's id, the sha256 of the decoded JSON equals the stated digest, the marker key equals the run's work key, and the JSON passes a strict schema. Otherwise it is ignored and the run logs `pr_state_ignored` with the reason (`untrusted-author`, `digest-mismatch`, `key-mismatch`, `malformed`). The lowest-id trusted block wins, as in `readParkState`. The digest catches an accidental or partial edit; the author id is the real trust boundary.
3. **Identity unavailable fails closed.** When `users.getAuthenticated` fails (for example a GitHub App installation token), every marker comment is ignored with `identity-unavailable` and nothing is restored.
4. **Reconcile.** Local and remote state merge monotonically: `used` counters take the max, `cap` comes from local (current config), handled review and comment ids and rounds are unioned (rounds deduped by kind, id and head sha, sorted by time), and `status`, `spec` and `prNumber` come from the side with the later `updatedAt`. A restore can raise a counter, never lower one. One missing side returns the other.
5. **Content.** An allow-list rebuild keeps only known fields. `spec.summary` (the spec's Goal section) goes through `redactSecrets` and is cut to 1000 characters. Handled ids keep the last 200 and rounds the last 50. If the encoded comment still exceeds 60,000 characters, rounds and ids are halved until it fits. No model output, transcripts or environment values are stored.
6. **When.** On start, before review-rework claims, `shipIssue` looks up the open PR for the branch, loads and reconciles the state and seeds the review-rework store with handled ids it lacks. After every run-state update, once a PR number is known, the local state is written first and then saved to the PR. Any GitHub failure logs `pr_state_failed` and the run continues on local state. Resume, local-only and `--no-pr` runs skip both.

## Consequences

- A fresh clone of a disposable host resumes with its handled review rounds and the remaining cap.
- Each run-state update may edit one PR comment; an unchanged state skips the edit.
- A GitHub App installation token restores nothing until identity can be read.
- Non-GitHub trackers have no factory PR adoption path, so they restore nothing.

## Alternatives considered

- **Git notes or a state branch.** Rejected: needs push rights beyond the PR and clutters the repo.
- **PR body.** Rejected: the body is human-edited and rewritten by SHIP.
- **A GitHub Actions cache or artifact.** Rejected: not readable with only `GH_TOKEN` from a fresh clone.
- **Trusting any comment with a valid digest.** Rejected: anyone can compute the digest of a forged payload.
