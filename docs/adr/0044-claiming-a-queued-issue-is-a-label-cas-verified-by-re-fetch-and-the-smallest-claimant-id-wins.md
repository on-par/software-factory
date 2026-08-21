# ADR-0044: Claiming a queued issue is a label CAS verified by re-fetch, and the smallest claimant id wins

- Status: Accepted
- Date: 2026-08-21

## Context

Moving the factory's work queue off the local `.factory/queue` file onto GitHub issues (#822)
needs a primitive that lets one factory instance mark an issue as "mine" in a way a
concurrent instance can see and respect. GitHub's labels API offers no compare-and-set: two
processes can both `POST /issues/{n}/labels` and both succeed, because adding a label is
idempotent and unconditional. There is no ETag-guarded label write, no transaction, and no
queue primitive on the issues API to lean on.

Two constraints shaped the answer. First, the resolution has to be *deterministic* — the
losing caller must be able to work out that it lost from the same evidence the winner sees,
with no coordinator, no clock comparison, and no extra round of negotiation. Second, the
claimant identity has to be unique per *claimer*, not per machine: the factory routinely runs
several lanes concurrently on one host, and if two of them compute the same
`factory:claimed-by:<host>` label, both would read back exactly one claim label, find it equal
to their own, and both believe they won. The factory already has a holder identity of exactly
the right granularity — `packages/core/src/utils/run-lock.ts` records `pid` plus `host` for a
run lock — so there is nothing to invent.

## Decision

A claim is a label compare-and-set with a mandatory read-back. `claimNext` adds
`factory:in-progress` and `factory:claimed-by:<id>` to a candidate, then re-fetches that
issue's labels and inspects every `factory:claimed-by:*` label present. The caller wins only
when the lexicographically smallest such label is its own; a caller whose own label is absent
from the read-back, or whose label is not the smallest, has lost. A loser removes only its own
`factory:claimed-by:<id>` label — never `factory:in-progress`, which the winner also added —
and advances to the next candidate. `factory:queued` is removed *after* the read-back confirms
the win, never before, so a crashed or abandoned attempt always leaves the issue claimable.

The claimant id is `slug(hostname())-<pid>`, reusing the `(host, pid)` holder identity
run-lock already writes, slugified to `[a-z0-9-]` and truncated so the whole label name fits
GitHub's 50-character label-name limit. Candidates are always evaluated in ascending issue
number order, so the candidate sequence itself is deterministic too.

## Consequences

Positive: no coordinator, no lock file, and no extra state store — the issue's own labels are
the entire protocol, readable by a human in the GitHub UI and by any other factory instance.
Losers resolve without a second negotiation round and simply fall through to the next
candidate, so a contended queue still drains. Because `factory:queued` survives until the win
is confirmed, every crash window leaves the issue recoverable rather than stranded.

Negative: the winner is decided by an arbitrary total order on ids, not by who asked first, so
claim outcomes are not fair — a host whose name sorts early wins contended issues
disproportionately. Each claim attempt costs at least two API calls (add, then read back), and
a contended queue costs that per losing candidate. The read-back is a snapshot, so a claimant
arriving strictly after the winner's read-back adds a label the winner never saw; that late
arrival's own read-back shows it lost, which is correct, but it means the winner's view is
never proof that no one else ever attempted. Tying identity to pid means a restarted process
does not recognise its predecessor's claims as its own — a stale `factory:claimed-by:*` from a
dead process needs the separate reaper #822 will bring, not this module.

## References

- [Issue](https://github.com/on-par/software-factory/issues/824)
- [Epic](https://github.com/on-par/software-factory/issues/822)
- [ADR-0009 — fenced steal of stale file locks (the local-lock sibling of this protocol)](https://github.com/on-par/software-factory/blob/main/docs/adr/0009-fenced-steal-of-stale-file-locks.md)
