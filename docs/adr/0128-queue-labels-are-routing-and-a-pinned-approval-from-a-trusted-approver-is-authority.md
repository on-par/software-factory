# ADR-0128: Queue labels are routing, and a pinned approval from a trusted approver is authority

- Status: Accepted
- Date: 2026-10-01

## Context

The factory runs queued issues with an unattended agent (`claude -p --permission-mode bypassPermissions`). `claimNext` in `packages/core/src/queue/github-queue.ts` treats the `factory:queued` label as permission and never checks who added it. The work request reads the issue body at run time (`packages/core/src/work/github-issue.ts`), not the version that was approved. The repo is public. Today only admins can label, so the labeler gap is closed by accident, not by design, and any future bot or App token with issue write access could add labels. The edit-after-approval gap is open now: an author can change the body after the issue is queued.

## Decision

Queue labels (`factory:queued`, lane labels) are routing only. They say where and in what order work runs, never whether it may run.

Authority is a pinned approval from a trusted approver. `factory approve <issue...> --lane <lane>` posts a comment that contains a hidden marker `<!-- factory-approval v1 sha256:<hex> lane:<lane> -->` and a visible line that names the approver and the short hash. It also adds the queue labels. `factory queue add` becomes an alias that also approves.

The hash is SHA-256 (lowercase hex) over the issue title and body, after normalizing CRLF and CR line endings to LF. Nothing else is hashed: no labels, comments or metadata. Any edit to the title or body invalidates the approval. `v1` versions the marker format and the hash inputs. Changing either needs a new version.

Trusted approvers are listed in `intake.trustedApprovers: string[]`. When it is unset, the default is the users with `admin` permission on the repo, read through the GitHub collaborator permission API. This repo sets `['patrob']`.

Before claiming, `claimNext` checks three things:

1. The most recent `labeled factory:queued` timeline event was made by a trusted approver.
2. The newest approval comment written by a trusted approver carries the marker. Markers in comments by anyone else are ignored, so a forged marker counts for nothing.
3. The marker's hash equals the hash of the current title and body.

On refusal, `claimNext` skips the issue, leaves `factory:queued` in place, adds `factory:needs-reapproval`, and logs a `claim_refused_unapproved` event. The reason is `untrusted labeler` (with the login), `missing approval`, or `content changed`.

Rollout is controlled by `intake.enforce: 'warn' | 'enforce'`. In `warn`, refusals are logged and labeled but the claim goes ahead. In `enforce`, a refusal blocks the claim. Ship in `warn`, run `factory approve` on the issues already queued, then switch this repo to `enforce`.

The check fails closed. If the timeline, comments or collaborator permissions cannot be read, the issue is not claimed in either mode. An unreadable approval is never treated as an approved one. Warn mode only relaxes a verified refusal.

Any new path that starts unattended work from a queue label must go through this check.

## Consequences

A label added by an untrusted actor, an edit made after approval, and a forged marker can no longer cause a run. Each approval is auditable as a comment that names a person and a hash.

Every edit, including a typo fix, needs re-approval. A GitHub API outage stalls claiming. Approvals rely on GitHub identity and comment authorship, with no out-of-band signing. Warn mode is temporarily permissive by design. The Factory App admission path (`packages/core/src/admission`) is not covered by this ADR.

References: ADR-0127, issue #1802, issue #1824.
