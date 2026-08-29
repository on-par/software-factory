# ADR-0060: A stale claim is one whose claimed-by label round-trips to this host and whose pid is dead

- Status: Accepted
- Date: 2026-08-29

## Context

`factory doctor --reconcile` reaps a dead run's resources. Claim labels are the last piece:
an issue claimed by a killed supervisor keeps `factory:in-progress` +
`factory:claimed-by:<host-slug>-<pid>` and, because `claimNext` refuses any candidate carrying a
`factory:claimed-by:` label and the claim already removed `factory:queued`, becomes invisible to
the queue until a human intervenes (#980).

The only liveness evidence a claim label carries is a pid, and a pid is meaningful only on the
machine that minted it. Probing a foreign host's pid against the local process table is not a
weak signal — it is a wrong one: an unrelated local pid makes a dead remote claim look live, and
an absent local pid makes a live remote lane look dead. Releasing on that second case hands the
same issue to a second lane, which is strictly worse than leaving the claim for a human. The
label also loses information on the way in: `defaultClaimantId` truncates the host slug against a
budget that depends on the pid's digit count, so a substring comparison against `hostname()` is
not reliable either.

## Decision

A claim is stale only when both halves of a round-trip hold. `localClaimPid(label, host)` parses
the trailing `-<digits>` of a `factory:claimed-by:` label as a pid and returns it only when
`claimedByLabel(defaultClaimantId(host, pid))` reproduces the observed label byte-for-byte — the
same slug and the same truncation budget the claimant used. `findStaleClaims` then releases an
issue only when it carries at least one `factory:claimed-by:` label and EVERY such label both
round-trips for this host and names a pid the signal-0 probe reports dead. An issue carrying
`factory:in-progress` with no claim label, a claim label from another host, or any live pid is
left untouched. Release itself delegates to `GithubQueue.release(issue, 'queued')` so the label
taxonomy has exactly one definition of "back in the queue".

## Consequences

Positive: the reaper can never yank an issue away from a live lane on another machine, and the
round-trip is exact rather than heuristic — no substring or prefix guessing against a truncated
slug. Reusing `release` keeps lane/order labels intact, so a released issue re-enters the queue
at its original position.

Negative: claims are only reapable from the machine that made them, so a permanently retired host
leaves claims that still need a human (or a run of doctor on a machine with that hostname). A
hostname change (DHCP-style `.local` renames) has the same effect. Pid recycling can also make a
dead claim look live, delaying — never wrongly performing — a release. All three failure modes
are conservative by construction: doubt keeps the claim.

## References

- [Issue #980 — factory: no run-lifecycle reaping](https://github.com/on-par/software-factory/issues/980)
- [Issue](https://github.com/on-par/software-factory/issues/999)
