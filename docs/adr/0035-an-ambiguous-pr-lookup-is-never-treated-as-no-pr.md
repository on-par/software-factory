# ADR-0035: An ambiguous PR lookup is never treated as "no PR"

- Status: Accepted
- Date: 2026-08-19

## Context

`shipPhase`'s duplicate-PR guard asks GitHub whether a PR already exists for the branch.
Until now both lookups (`findOpenPR`, `findMergedPR`) collapsed every outcome into
`number | undefined`: a successful empty listing and a thrown 502, secondary rate limit,
or network reset were indistinguishable. The recovery path keyed off that `undefined`,
so a transient API blip made an existing PR look absent, re-pushed the branch, and called
`pulls.create`, which 422'd because the PR was there all along — parking the lane with an
error that named neither the blip nor the real PR. This is the same failure mechanism
behind the duplicate-PR bug class that #520/#527 partially addressed, recorded as finding
H2 in `docs/research/architecture-tech-debt-review-2026-08-09.md`. The surrounding code
had already converged on this shape for local evidence — `describePushFailure` and
`RemoteHeadCheck`'s `mismatch`/`unreadable` split (#734/#735) both refuse to proceed on
an unreadable answer — and ADR-0014 made the same call for CI check conclusions. Remote
lookups were the remaining hole.

## Decision

A remote lookup that decides whether a PR exists returns a discriminated result —
`found` / `absent` / `error` — and callers must branch on all three. `shipPhase` fails
closed on `error`: it logs a `ship` event naming the lookup and the bounded error detail
and returns `{ ok: false }`, taking neither the push nor the `pulls.create` path. Only a
verified `absent` may be read as "no PR exists". The one exception is the already-merged
probe, where an errored lookup is still overridden by local git evidence
(`recoveryState.landed` — HEAD's tree is identical to `origin/main`), because that
evidence is definitive without the API. Because failing closed converts blips into parked
lanes, the shared client the CLI hands to core is wrapped with `@octokit/plugin-retry` and
`@octokit/plugin-throttling` so a transient 5xx or rate limit is retried before it can
ever be classified as an error. Additionally, a `pulls.create` that still 422s with an
already-exists message is recoverable, not terminal: ship re-queries for the existing PR
and continues with it.

## Consequences

Positive: a transient GitHub failure can no longer manufacture a duplicate PR or a raw
422 stack in a lane's log; ship's failure messages now name the API error that caused the
abort; the retry/throttle wrapper benefits every CLI GitHub call, not just ship's; and the
422 recovery closes the last window where two racing actors both try to open the PR.
Negative: a sustained GitHub outage now parks lanes at ship that would previously have
blundered forward, so operators see more parked lanes (with clearer reasons) rather than
fewer; every future PR-existence lookup carries the cost of branching on three states
instead of two; and the CLI takes on two more npm dependencies whose retry behaviour is
now on the critical path of every GitHub call.

## References

- [Issue #641 — findOpenPR/findMergedPR treat any GitHub API error as 'no PR'](https://github.com/on-par/software-factory/issues/641)
- [ADR-0014 — The CI merge gate fails closed on any conclusion outside the passing allow-list](https://github.com/on-par/software-factory/blob/main/docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
