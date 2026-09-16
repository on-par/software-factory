# ADR-0105: worktree-gc's no-active-claim check reads claim staleness through the queue's lease primitive

- Status: Accepted
- Date: 2026-09-15

## Context

Worktree-gc's `no-active-claim` heuristic (#1355) quarantines a factory-owned worktree whose
branch's PR is merged or closed and whose owning issue has no active claim — evidence that the
lane finished or was abandoned without releasing its worktree. `resolveActiveClaim` judged
"active" by presence alone: any `factory:claimed-by:*` label on the issue read as `'claimed'`,
regardless of how stale that claim actually was.

That was fine as long as a claim's only exit was an explicit release, but ADR-0104 (#1500)
changed what a claim label means: `claimNext` now mints it alongside a
`factory:claim-expires:<epochSeconds>` lease label, and the queue's own reconcile
(`findStaleClaims`/`releaseStaleClaims` in `stale-claims.ts`) treats a lapsed lease as stale
regardless of which host observes it — no pid or hostname evidence involved anywhere. Worktree-gc
did not get that same upgrade: a lane whose device died mid-issue (the exact #1500 scenario) still
carries its `factory:claimed-by:*` label until the queue's own reconcile pass happens to run and
strip it, and until then `resolveActiveClaim` kept reading the abandoned claim as active —
leaving the worktree in place indefinitely even though the issue-level reconcile would have
already released it. Reimplementing lease-expiry comparison a second time inside `worktree-gc.ts`
would just recreate the two-sources-of-truth risk ADR-0104 was written to avoid.

## Decision

`resolveActiveClaim` now calls `findStaleClaims` directly (the same primitive ADR-0104/#1506
built for the queue's own reconcile) on the single issue it just fetched, instead of stopping at
"does a `factory:claimed-by:*` label exist." A claim reads as `'unclaimed'` when either: no
`factory:claimed-by:*` label is present (unchanged from before), or one is present but
`findStaleClaims` finds an expired `factory:claim-expires:*` lease on the same issue. An issue
that carries a claimed-by label with no expiry label at all (no lease evidence either way) keeps
reading as `'claimed'`, matching `findStaleClaims`'s own "no lease label ⇒ never releasable"
rule.

## Consequences

Positive: worktree-gc's claim evidence now derives from the exact same lease comparison the
queue uses to reconcile claims, so an abandoned lane's worktree stops waiting on a separate
release step — an expired lease reads as unclaimed the moment worktree-gc's next sweep runs,
on any host, closing the cross-host gap ADR-0104 fixed for the queue but left open here. There is
now exactly one place (`findStaleClaims`) that knows how to compare a claim-expires label against
`now()`; a future change to lease semantics only has one call site to update.

Negative: worktree-gc's dry-run/real-mode quarantine tier now depends on `packages/core/src/queue`
internals it previously only used for label-name constants, tightening the coupling between the
two modules — acceptable since both already model the same claim lifecycle and `stale-claims.ts`
is itself part of core's public claim-lease vocabulary.

## References

- [Issue #1501 — Extend lease-based reaping to worktree-gc's no-active-claim check](https://github.com/on-par/software-factory/issues/1501)
- [ADR-0104 — Claim staleness is a TTL lease with heartbeat, not host-pid liveness](0104-claim-staleness-is-a-ttl-lease-with-heartbeat-not-host-pid-liveness.md)
- [ADR-0090 — worktree-gc real mode quarantines the two heuristic stale reasons instead of deleting](0090-worktree-gc-real-mode-quarantines-the-two-heuristic-stale-reasons-instead-of-deleting.md)
