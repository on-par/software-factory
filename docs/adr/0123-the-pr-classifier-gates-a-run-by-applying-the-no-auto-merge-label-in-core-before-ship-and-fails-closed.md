# ADR-0123: The PR classifier gates a run by applying the no-auto-merge label in core before SHIP, and fails closed

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0121 allows a PR classifier only to escalate review, and #1721/#1723 built a deterministic review floor plus repo overrides that nothing consumed. The merge decision is made in the CLI's `waitForMerge`, which by then only knows the issue number and branch name. `shipIssue` does not return the CHECK data or diff base, so `waitForMerge` cannot compute a floor. `waitForMerge` already treats the filing policy's `selfFixLabel` (`no-auto-merge`) as a fail-closed human gate, and a label-read failure already counts as blocked. A second gating channel (state files, return values, a new merge mode) would duplicate that gate and could drift from it.

## Decision

When the PR classifier setting is on (`--pr-classifier` > `run.merge.classifier` > `FACTORY_PR_CLASSIFIER=1` > default off, resolved by `resolvePrClassifierPolicy`), `runIssue` computes the review floor after CHECK passes and before SHIP. It uses the full PR diff against CHECK's base ref (origin/main or origin/master merge-base, with `build.diffBase` as the fallback), including untracked files, and the repo-merged floor rules. For a B or C floor it applies the `selfFixLabel` to the issue and logs `merge-gated` with the reason `classifier:floor:<class>:<rule ids>`. Any error while computing the floor is treated the same way, with the reason `classifier:error`. If the label cannot be applied, the run is parked `held` rather than shipped. The classifier only ever adds the label; it never removes it and never approves. The decision is published as a "Review routing" section in the PR evidence pack. `waitForMerge` is the only merge gate and is unchanged.

## Consequences

Positive: one gate (the label) covers human-requested holds, self-fix bugs and classifier holds alike. The gate survives process restarts, is visible on GitHub, and a human can clear it. Errors and partial failures always end in "a human decides".

Negative: the label is per-issue and coarse. The reason lives only in the event log and the evidence pack, not on the label. A floor computed before SHIP does not see files SHIP itself adds, such as ADR drafts under `docs/adr`. A label-apply outage parks otherwise-good runs. A later model-based classifier must plug into this same pre-SHIP seam and may only escalate.

References: ADR-0121, ADR-0122, issue #1724.
