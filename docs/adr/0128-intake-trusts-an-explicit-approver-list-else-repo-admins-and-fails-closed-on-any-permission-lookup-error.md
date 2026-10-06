# ADR-0128: Intake trusts an explicit approver list, else repo admins, and fails closed on any permission lookup error

- Status: Accepted
- Date: 2026-10-01

## Context

Intake approval enforcement (#1802) will gate which issues the factory may claim on an approval from a trusted human. Every later caller (claimNext, `factory approve`, doctor) needs the same answer to "is this login trusted?". Many repos never configure an approver list, so the factory needs a safe default. GitHub's collaborator-permission API can return 404 for non-collaborators and can fail on network, auth or rate-limit errors. Treating those errors as "trusted", or widening trust when a list is present but empty, would defeat the gate. GitHub logins are case-insensitive.

## Decision

`isTrustedApprover` in `packages/core/src/queue/approval.ts` owns the trust decision. When `intake.trustedApprovers` is set, including an empty list, only those logins are trusted, compared case-insensitively, and the GitHub API is not consulted. Only when it is unset does trust fall back to the login having `admin` permission on the repo, read through the injected `CollaboratorPermissionClient` port (Octokit `repos.getCollaboratorPermissionLevel`). Any other permission level, and any error or rejection from that lookup, means not trusted. The helper never throws. `intake.enforce` defaults to `warn`; a repo switches to `enforce` only by explicit config.

## Consequences

Every future approval check gets one auditable, fail-closed rule, and repos with no config get a reasonable default (admins). A GitHub outage makes every approval untrusted, which only warns in `warn` mode but blocks claims in `enforce` mode. Maintainers with `maintain`/`write` are not trusted unless listed explicitly. `trustedApprovers: []` blocks all approvals rather than falling back to admins.

References: issue #1825, parent issue #1802.
