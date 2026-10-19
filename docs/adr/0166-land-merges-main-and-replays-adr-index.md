# ADR-0166: Land merges main and replays conflicted ADR index rows by href

- Status: Accepted
- Date: 2026-10-19
- Issue: #1886

## Context

Concurrent lanes can add separate ADR documents while editing the same generated table in
`docs/adr/README.md`. Rebasing and force-pushing a DIRTY pull request rewrites its published
history and parks even when the table is the only conflict.

## Decision

Inside the existing short land lock, fetch `origin`, merge `origin/main`, and push the lane
branch with an ordinary non-force push. Keep CI waits outside the lock and re-read PR state
inside it. When the README is the sole unmerged path, take main's README table and replay the
metadata from lane-added ADR documents. Upsert table rows by exact href, so distinct documents
with the same ADR number coexist and only an identical href replaces a row. Preserve all other
main rows and the ADR document contents.

Any other conflict aborts the merge and parks with the unresolved paths. Replay, staging, or
commit failures abort this merge and report abort failures. A rejected push parks the lane and
leaves the local merge commit available for inspection. No push is retried or forced. Conflict
detection and successful mechanical replay are recorded as structured events.

This decision supersedes ADR-0037's rebase and force-push mechanism for DIRTY PR recovery. Its
mutation-only lock, in-lock state re-read, and unlocked CI invariants remain binding.

## Consequences

Main and lane history are retained in a merge commit, and routine competing ADR additions can
land without operator repair. The recovery is deliberately limited to a sole README index
conflict; source conflicts and rejected pushes still require intervention.
