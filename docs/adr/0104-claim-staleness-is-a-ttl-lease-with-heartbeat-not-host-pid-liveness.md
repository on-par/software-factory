# ADR-0104: Claim staleness is a TTL lease with heartbeat, not host-pid liveness

- Status: Accepted
- Date: 2026-09-15
- Supersedes: ADR-0060

## Context

ADR-0060 made `findStaleClaims`/`releaseStaleClaims` conservative by construction: a claim was
only ever reapable from the exact host that minted it, because the only liveness evidence a
`factory:claimed-by:<host-slug>-<pid>` label carried was a pid, and a pid is meaningful only on
the machine that produced it. That was the right call for a single-host factory, but it created
a real multi-device gap (#1500): if a device dies mid-issue — laptop closed, VM torn down,
hostname rotated by DHCP — no _other_ device can ever free its claim. The issue sits claimed
forever, invisible to `claimNext`, until a human edits labels by hand. #1087 tracked the same
gap from the "restore issues from dead claims" angle and is folded into this decision.

Host-pid liveness cannot be fixed by widening the check — probing a foreign host's pid against
a local process table is not weak evidence, it is _wrong_ evidence, exactly as ADR-0060 argued.
The only way to make staleness evaluable by any node in the fleet is to stop asking "is the
process that claimed this still alive" (unanswerable across hosts) and start asking "has the
owning process said it's still working this, recently enough" — a lease.

## Decision

A claim now carries its own expiry: `claimNext` mints a `factory:claim-expires:<epochSeconds>`
label (`claimExpiresLabel`/`parseClaimExpiresLabel` in `github-queue.ts`) alongside the existing
`factory:in-progress` and `factory:claimed-by:*` labels, set `DEFAULT_CLAIM_LEASE_MS` (15
minutes) in the future. `GithubQueue.heartbeat(issue)` refreshes that label — but only when this
claimant's own `factory:claimed-by:*` label is still present on the issue, so a heartbeat can
never resurrect a claim that was released or reaped out from under it. `runLane` calls
`heartbeat` on a 5-minute interval (`HEARTBEAT_INTERVAL_MS` in `cli/index.ts`) for the whole
span an issue is in flight (`ship` and `waitForMerge`), comfortably inside the 15-minute lease so
a normal poll cadence never lets it lapse.

`findStaleClaims`/`releaseStaleClaims` (`stale-claims.ts`) now compare `parseClaimExpiresLabel`
against `now()` instead of resolving a pid: an issue with no `factory:claim-expires:*` label
carries no expiry evidence and is never released (mirrors ADR-0060's "no claim label" case); an
issue whose lease has passed is stale regardless of which host observes it. `localClaimPid`,
the `host`/`isPidAlive` options, and `os.hostname()` are removed from the module's surface
entirely — there is no host-scoped evidence left to reason about, so the "which host may reap
this" question no longer exists.

## Consequences

Positive: reaping is identical on every host by construction — any node in the fleet can now
free a claim left behind by a dead device, closing the #1500/#1087 gap without reintroducing the
foreign-claim race ADR-0060 was built to avoid (a live claimant's heartbeat keeps its lease ahead
of `now()`, so a healthy claim is never yanked out from under it). The reap decision is a single
integer comparison instead of a slug round-trip plus a signal-0 probe, which also removes an
entire class of host-rename/pid-recycling edge cases from the code (and their comments).

Negative: a claimant that stops heartbeating without releasing (crash, SIGKILL, frozen event
loop) keeps its claim for up to one full lease window rather than being detected the instant its
pid dies — the old pid-liveness check could, in principle, notice a local death immediately.
Clock skew across hosts now matters for correctness: a node with a fast clock could judge a
still-live claim stale early. Both are accepted as normal lease-system trade-offs, and both fail
in the safe direction bounded by the lease window rather than indefinitely, which is strictly
better than ADR-0060's "a permanently retired host leaves claims only it can free."

## References

- [Issue #1500 — Replace localClaimPid host-local liveness check with lease TTL + heartbeat](https://github.com/on-par/software-factory/issues/1500)
- [Issue #1087 — Restore issues from dead factory claims](https://github.com/on-par/software-factory/issues/1087)
- [ADR-0060 — A stale claim is one whose claimed-by label round-trips to this host and whose pid is dead](0060-a-stale-claim-is-one-whose-claimed-by-label-round-trips-to-this-host-and-whose-pid-is-dead.md)
