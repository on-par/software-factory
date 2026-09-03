# ADR-0036: Pause and resume act only on live registry entries; a detached tombstone is never revived

- Status: Accepted
- Date: 2026-08-19

## Context

The factoryd repo registry (`~/.factory/registry.json`) keeps `detached` entries as
tombstones rather than deleting them, so a detach is auditable. Pause and resume
(#779) toggle an entry's `state` between `active` and `paused`, which raises an
unavoidable question the code alone cannot answer: what should
`POST /repos/<owner>/<name>/resume` do when the entry exists but is `detached`?
Treating resume as a plain state setter would revive the tombstone to `active` and
put the repo back into dispatch — bypassing the entire attach precondition gate in
`repos-attach.ts` (origin remote must resolve to the posted slug, `.factory/config.json`
must exist). The checkout behind a detached entry may have been moved, deleted, or
re-pointed at a different remote since the detach, so those preconditions are exactly
what must not be skipped. The forcing constraint is that the detach story is still to
come; whatever rule is set here is the one detach must be written against.

## Decision

`setRepoState` operates only on live entries. A slug whose entry is `detached` is
rejected with `reason: 'detached'` (HTTP 409) and the registry file is not written —
the same no-write-on-rejection contract `attachRepo` already holds. A slug absent from
the registry is rejected with `reason: 'unknown-repo'` (HTTP 404). Re-entering
dispatch after a detach requires a fresh `POST /repos`, which runs the full attach
precondition gate. Pause and resume are idempotent within the live states: pausing an
already-paused repo, or resuming an already-active one, succeeds and leaves that state
in place.

## Consequences

Positive: a repo can only ever enter `active` through a validated attach, so dispatch
can never be pointed at a stale or wrong checkout by a two-character API call.
Detached stays a genuine terminal tombstone, which keeps the detach story's contract
simple and keeps the registry's audit trail meaningful. The distinct `unknown-repo`
and `detached` reasons let an operator tell "never attached" from "attached and
released" without reading the file.
Negative: re-attaching after a detach costs an extra call and the operator must supply
the path again — resume is not a shortcut back. Two failure reasons and two status
codes are slightly more API surface than one catch-all 404, and every future writer of
a state-changing repo route has to honor the same live-entries-only rule.

## References

- [Issue #779 — factoryd: pause and resume an attached repo via HTTP](https://github.com/on-par/software-factory/issues/779)
- [Epic #761 — factoryd: repo registry + attach/detach/pause HTTP API](https://github.com/on-par/software-factory/issues/761)
