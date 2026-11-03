# ADR-0173: A repo whose tracker is Linear reads its queue from Linear

- Status: Accepted
- Date: 2026-11-03
- Amends: [ADR-0168](0168-a-repo-reads-tickets-from-one-configured-tracker-and-a-workkey-string-replaces-the-numeric-issue.md) (replaces decisions 1, 5 and 12 for a Linear tracker only)
- See also: [ADR-0044](0044-claiming-a-queued-issue-is-a-label-cas-verified-by-re-fetch-and-the-smallest-claimant-id-wins.md) (claim CAS), [ADR-0045](0045-github-queue-order-is-explicit-per-lane-label-metadata.md) (GitHub label queue order), [ADR-0108](0108-queuebackend-is-a-narrow-4-method-seam-adapted-from-githubqueue-rather-than-replacing-it.md) (QueueBackend seam), epic #3872

## Context

ADR-0168 decision 1 keeps the queue, lanes, supervisor and claims GitHub-only. It asks for a separate ADR for a tracker-backed queue through ADR-0108's `QueueBackend`. Decision 5 says the factory never transitions tracker statuses. Decision 12 makes Linear a planned kind, built when needed. Epic #3872 now builds the Linear queue.

Linear constraints shape the design:

- Labels in a label group are mutually exclusive: an issue holds one label per group.
- Workflow states are per team.
- Attachments carry arbitrary metadata.
- Linear's GitHub integration moves issues to In Review and Done when it finds the issue key in a branch name, PR title or PR body.

## Decision

Label and state names below are illustrative and negotiable.

1. **Scope.** This applies only when `tracker.kind` is `linear`. It replaces ADR-0168 decisions 1, 5 and 12 for Linear only.
   GitHub queue behaviour is unchanged. GitHub keeps ADR-0044 claims and ADR-0045 label order. Jira stays as ADR-0168 says.
2. **Mapping.** One Linear project maps to one repo.
3. **Queued work.** A ready label (for example `factory:ready`) marks queued work. Only issues in the mapped project, in the ready state, with the ready label and without a claimed-by or parked label are candidates.
4. **Lanes.** Lanes come from a lane label group (for example `lane`). Linear allows one label per group, so each issue has exactly one lane. An issue with no lane label goes to the default lane.
5. **Order.** Linear priority first (Urgent > High > Medium > Low; "No priority" sorts last), then an order label, then creation date (oldest first).
6. **Claim.** A claim adds a claimed-by label (for example `factory:claimed-by:<claimantId>`), moves the issue to In Progress, then re-fetches. When more than one claimed-by label is present, the smallest claimant id wins and the losers remove their label, as in ADR-0044.
7. **Lease.** The claim lease lives in a factory-owned attachment's metadata (claimant id and expiry), not in a label per expiry time. Renewal updates the attachment. A reaper treats an expired attachment lease as a released claim.
8. **Park.** A park adds the parked label, posts a comment with the reason, and moves the issue back to the ready state.
9. **Status ownership.** The factory sets only the claim state (In Progress) and the park state (back to ready). In Review and Done come from Linear's GitHub integration, which reads the issue key in the branch, PR title and PR body (ADR-0168 decisions 3 and 5 already put the key there).
10. **Seam.** The Linear queue implements ADR-0108's `QueueBackend`. It does not fork the GitHub queue.

## Consequences

- The Linear queue slices of #3872 have one text to build against.
- The factory now writes two Linear states, which departs from ADR-0168 decision 5 for Linear only.
- A team without Linear's GitHub integration gets no In Review or Done transitions.
- The lease no longer pollutes labels.
- Label and state names stay configurable or negotiable.

## Alternatives considered

- **A lease label per expiry time.** Rejected: label churn and a growing label set.
- **The factory setting In Review and Done itself.** Rejected: it duplicates Linear's GitHub integration.
- **Keeping the Linear queue GitHub-only.** Rejected: it blocks epic #3872.
