# ADR-0052: Hosted-exec GitHub access is brokered per job through an injected mint port, never ambient host credentials

- Status: Accepted
- Date: 2026-08-26

## Context

The hosted-exec tracer bullet (parent #895) runs factory jobs in disposable containers that
need repo write access. GitHub authority is the highest-value credential to scope before the
provider-session work in later slices. The container currently clones an unauthenticated public
URL and would otherwise inherit whatever GitHub token the host process holds — a broad,
long-lived, cross-repo credential inside untrusted job code. Core is deliberately hermetic
(the hosted store/container/docker modules keep all network/fs/Docker effects behind injected
ports), and real GitHub App installation-token minting (JWT signing + installation API) is out
of scope for this MVP, but the first prototype still needs _some_ working credential.

## Decision

Every hosted job that needs GitHub access obtains a per-job, single-repo GitHubCredentialBundle
from a broker (packages/core/src/hosted/github-authority.ts) that mints the raw token through an
injected MintGitHubToken port — so a real GitHub App minter drops in later without touching the
broker. The bundle's kind is 'installation' for a real App token or the explicitly-marked
'prototype-fallback' for the first prototype's local token; a fallback is never silently treated
as a scoped App token. The bundle is injected into the container as the job credential path
(authenticated remote + a .git-credentials mount inside the per-job workspace) and is the only
GitHub credential the container sees — ambient host credentials are never passed in. The raw
token value is redacted from every event, log, clone error, and trace via redactGitHubCredential,
and the credential mount is removed with the workspace at cleanup. The whole path is gated by
resolveHostedAuthority on the FACTORY_HOSTED_EXEC flag, so the local factory path keeps its
existing local GitHub auth unchanged.

## Consequences

Positive: repo write authority handed to untrusted job code is job-scoped, single-repo,
redacted, and disposable; the mint port keeps core dependency-free and lets the real GitHub App
path land later as a pure injection; future provider-session brokers (#895) inherit the same
per-job broker + redaction + cleanup boundary. Negative: the prototype fallback token is still a
real credential whose true scope depends on the injected minter, so 'prototype-fallback' must
remain visibly marked and short-lived until the App path exists; the credential currently rides
inside the workspace mount rather than a separate secret mount, which is adequate for a
single-file disposable workspace but would need revisiting for richer secret sets.

## References

- [Issue](https://github.com/on-par/software-factory/issues/901)
- [ADR-0001 boss-worker-checker pipeline (per-issue isolation)](docs/adr/0001-boss-worker-checker-pipeline.md)
