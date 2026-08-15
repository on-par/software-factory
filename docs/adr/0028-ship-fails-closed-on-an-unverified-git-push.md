# ADR-0028: SHIP fails closed on an unverified push — no PR is created or readied unless the remote head provably matches local HEAD

- Status: Accepted
- Date: 2026-08-14

## Context

`shipPhase` used to swallow `git push` rejections at both of its push sites ("push
failed — trying to continue") and proceed to create, evidence, and ready the PR. A
stale remote branch (non-fast-forward rejection) or a network failure therefore
produced a PR pointing at a remote head missing the run's commits, while `shipPhase`
still returned `{ ok: true, prNumber }` and logged `ready` — and the downstream merge
train squash-merged work that was never on the remote. This is the same fail-open
shape already rejected elsewhere in the factory: ADR-0014 fails the CI gate closed on
any non-allow-listed conclusion, and ADR-0018 forbids deriving a dedup index from an
unverified `gh` listing. The push seam needed the same rule. Retry infrastructure was
explicitly out of scope (issue #640), and a rejected non-fast-forward push never
succeeds on retry anyway.

## Decision

SHIP fails closed at every push site. After a failed `git push`, `shipPhase` logs the
actual rejection (stderr preferred) and continues only when `git ls-remote origin
refs/heads/<branch>` reports exactly the SHA of local `git rev-parse HEAD`; any
mismatch, missing remote ref, or `ls-remote` failure is unverified, and the ship
returns a non-success outcome before any PR is created, updated, evidenced, or marked
ready. "Cannot verify" is treated as "not verified," never as success. Both the
recovery-branch push and the ADR-commit push obey the same rule; recovery of a
transient failure is left to the factory's existing re-run path rather than in-phase
retries.

## Consequences

Positive: a merge can no longer silently miss the run's commits — every `ready` ship
implies the remote head carried the local HEAD at push-verification time, and push
failures surface with their real git stderr in `.factory/events.ndjson`. Negative: a
transient network blip during push now parks the lane (a human-visible failure)
instead of possibly self-healing invisibly; that trade is accepted because the
invisible path is indistinguishable from lost work. Future push sites in SHIP must
reuse the same verified-push helper (`pushBranchVerified` in
`packages/core/src/phases/ship.ts`) rather than reintroducing a swallowing try/catch.

## References

- [Issue #640](https://github.com/on-par/software-factory/issues/640)
