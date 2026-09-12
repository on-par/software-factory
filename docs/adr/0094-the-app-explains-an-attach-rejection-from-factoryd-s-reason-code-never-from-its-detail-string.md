# ADR-0094: The app explains an attach rejection from factoryd's reason code, never from its detail string

- Status: Accepted
- Date: 2026-09-12

## Context

factoryd's `POST /repos` rejects an attach with `{ error, reason }` (packages/core/src/daemon/factoryd-http.ts),
where `reason` is core's `AttachFailureReason` union — `invalid-request`, `not-a-git-checkout`,
`origin-mismatch`, `missing-factory-config` — and `error` is the gate's human sentence
(`origin is on-par/other-repo, not on-par/software-factory`,
`/path/.factory/config.json not found`). The app needs to name the exact missing prerequisite
(#1381, epic #1376), and both fields are right there in the response, so there are two
tempting implementations: switch on the code, or pattern-match the sentence. The sentence is
the more tempting one because it already reads well and can be echoed straight through —
and that is precisely the coupling that breaks silently, since the sentence is free text
embedding absolute paths and slugs that core may reword at any time without a contract
change. The app also cannot share core's union at the type level: core is Node-only and
cannot be bundled into the browser app, so the union is mirrored by hand and can drift
behind a newer daemon that reports a reason this build has never heard of.

## Decision

The app classifies an attach failure exclusively from the response's `reason` code. A single
pure function, `explainAttachFailure(reason, detail)` in
`packages/dashboard/src/repoAttach.ts`, owns the only mapping from reason code to
operator-facing copy (`title` + `remediation`); factoryd's `detail` is carried through
verbatim for display as supporting evidence and is never parsed, matched, or branched on.
An unrecognized reason — including one from a newer daemon, a response with no `reason`
field, and a transport error, which maps to a synthetic `daemon-unreachable` — resolves to a
generic-but-honest explanation that still shows the verbatim detail, so the app degrades
rather than throwing or rendering an empty alert. Adding a prerequisite check to core's gate
therefore means adding its reason code to this map in the same or a following change; the
app will keep working without it, with a less specific message.

## Consequences

Positive: core is free to reword any gate message without breaking the app; every new
prerequisite failure has exactly one place to gain its remediation copy; the app never shows
an empty or crashed alert for an unknown reason; and the copy is unit-testable as a pure
function with no DOM or network.
Negative: the reason union is duplicated between core and the dashboard and can drift, and
the drift is only visible as a generic message rather than as a type error — accepted
because core is unbundleable in the browser and the fallback is safe. A newly added core
reason code also ships a vaguer app message until its copy is added.

## References

- [Issue #1381 — App onboarding: explain repo attach prerequisite failures](https://github.com/on-par/software-factory/issues/1381)
- [Epic #1376 — Factory app repo onboarding parity across devices](https://github.com/on-par/software-factory/issues/1376)
- [ADR-0034 — factoryd's HTTP API is authorized by its loopback binding alone](https://github.com/on-par/software-factory/blob/main/docs/adr/0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md)
