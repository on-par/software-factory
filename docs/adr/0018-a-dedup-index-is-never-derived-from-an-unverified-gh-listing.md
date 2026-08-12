# ADR-0018: A dedup index is never derived from an unverified `gh` listing

- Status: Accepted
- Date: 2026-08-12

## Context

Discovery's two write paths — `authorDraftEpic` (draft epics) and `advanceDraftEpic`
(child stories) — decide whether to create GitHub issues by diffing against an index
built from a `gh issue list` call. Both built that index inside a bare
`try { JSON.parse(result.stdout) } catch { index = [] }`, and neither consulted the
command's `ok` status. A failed CLI call (rate limit, expired auth, network blip) is
therefore indistinguishable from "the repo has no matching issues": the parse throws on
an empty or error-string stdout, the index becomes empty, nothing matches, and the code
creates issues it has already created — up to `DEFAULT_MAX_STORIES` duplicate stories per
invocation, with the epic checklist rewritten to point at the duplicates. Because these
duplicates land in the `ready` label the factory queue reads from, a transient CLI blip
converts directly into duplicated work being built. The forces are asymmetric: an
unnecessary abort costs one skipped discovery cycle that the next cycle retries, while a
false "nothing exists" costs irreversible writes to a shared backlog that a human must
clean up. The repo already made the same call for CI status in ADR-0014 (unknown check
conclusion is a failure, not a pass), and `advanceDraftEpic`'s sibling `gh issue view`
call already checked `ok` and returned an error action.

## Decision

A dedup index in `packages/core/src/discovery/` is only ever built from a listing whose
success is verified end to end. `advanceDraftEpic` and `authorDraftEpic` check the
`gh issue list` result's `ok` before parsing, and treat three conditions identically as
failure: `ok === false`, `JSON.parse` throwing, and a payload that parses to something
other than an array. Each aborts before any write — `advanceDraftEpic` returns
`{ action: 'error', detail }`, `authorDraftEpic` returns a new
`{ created: false, reason: 'list-failed', detail }` variant — so no `gh issue create`,
`gh label create`, or epic-body edit can run behind an unverified index. Only a
successful call that parses to an array produces an index, and the empty array `[]` from
such a call remains a legitimate empty index: a fresh repo still gets its first epic and
stories. The rule generalizes: any future code that decides whether to create a GitHub
object by diffing against parsed `gh` output must fail closed on an unverified listing,
never substitute an empty collection for one it could not read.

## Consequences

Positive: a transient `gh` failure can no longer mass-duplicate story or epic issues into
the factory queue; the failure is reported to the caller with the CLI's own output as the
detail instead of being swallowed; the two discovery write paths now match the
already-correct `gh issue view` handling in the same file, so there is one shape to learn.
Negative: a discovery cycle now aborts on a blip that it previously (accidentally) rode
through, so callers must tolerate `error` / `list-failed` results and retry on the next
cycle — there is deliberately no retry or backoff at this layer. `AuthorDraftEpicResult`
gains a fourth variant, so exhaustive consumers of that union must handle it. The audit of
every other `gh`-output parse site in the codebase remains open follow-up work; this ADR
states the rule those sites will be measured against.

## References

- [Issue #644 — Epic promotion never checks gh exit status](https://github.com/on-par/software-factory/issues/644)
- [ADR-0014 — The CI merge gate fails closed on any conclusion outside the passing allow-list](0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
