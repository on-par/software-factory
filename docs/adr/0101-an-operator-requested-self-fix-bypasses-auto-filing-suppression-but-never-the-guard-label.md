# ADR-0101: An operator-requested self-fix bypasses auto-filing suppression but never the guard label

- Status: Accepted
- Date: 2026-09-13

## Context

The factory has two distinct ways a fingerprinted defect becomes a bug issue. The first is the
automatic in-run path: when a lane parks, `evaluateFilingPolicy` (`packages/core/src/filing/policy.ts`)
decides whether to file at all, and deliberately suppresses filing for expected/throttle reasons
(`excludeReasons`: rate_limit, usage_cap, timeout, verify_failed) unless the same fingerprint has
recurred `repeatThreshold` times, and enforces `maxPerRun` / `maxPerDay` ceilings plus a global
`enabled` switch. Those knobs exist for exactly one purpose: to stop an unattended loop from flooding
the tracker with issues nobody asked for.

Epic #1379 adds a second path — a human operator looking at a failure in the app and explicitly
requesting a self-fix (#1392). Reusing the same policy gate for that path is tempting because it is
the code that already exists, but it produces a bad outcome: an operator who clicks "request self-fix"
on a `verify_failed` park would get a silent `skipReason: 'expected-condition'` and no issue, which is
indistinguishable from a broken button. The suppression rules are answers to a question the human has
already answered.

The guard label is the opposite case. `filing.selfFixLabel` (default `no-auto-merge`) is what
`isAutoMergeBlocked` reads to refuse auto-merging a PR that changes the factory's own code, and epic
#1379 explicitly lists "make self-fix merge gates obvious and non-bypassable" as scope. A self-fix
issue that is missing that label is a safety hole, not a cosmetic gap — and the pre-existing bump path
in `fileBug` only rewrote the issue body, so a reused issue could carry whatever labels it happened to
have.

## Decision

`requestSelfFix` (`packages/core/src/filing/self-fix.ts`) treats an explicit operator request as the
filing decision. It does not call `evaluateFilingPolicy`, and is therefore never suppressed by
`filing.enabled`, `filing.excludeReasons`, `filing.repeatThreshold`, `filing.maxPerRun`, or
`filing.maxPerDay`. It reads exactly two fields off `FilingPolicy` — `bugLabels` and `selfFixLabel` —
and applies their deduped union on both the create path and the reuse path, adding the labels to an
existing issue through `FilingGitHubClient.addLabels` when it bumps rather than creates. Exactly one
issue per fingerprint remains the invariant, enforced by the pre-existing hidden `fp:` marker dedup in
`fileBug`; the caller-facing `scanLabel` option on `createOctokitFilingClient` exists so a repo with a
renamed bug label still finds its own filed issues rather than creating a second one.

The automatic in-run path keeps using `evaluateFilingPolicy` unchanged. Any future operator-initiated
filing action follows this same split: caps and exclusions are for the unattended loop, the guard
label is for everyone.

## Consequences

Positive: the app's self-fix button always does what it says — one issue per fingerprint, always
guard-labelled, on the first request and on every repeat. The merge gate cannot be lost by a reuse.
`fileBug` and the automatic product-bug path keep their existing contracts and tests.

Negative: an operator can file self-fix issues past the configured per-day ceiling, so the ceiling is
no longer a hard bound on issues created in a day — only on issues created by the automatic loop. This
is accepted because the action is human-initiated, loopback-only, and one-issue-per-fingerprint by
construction, which bounds the damage to the number of distinct fingerprints an operator clicks.
Second: `FilingGitHubClient` grows a required `addLabels` method, so every implementation must provide
one.

## References

- [Issue #1392 — Self-healing: file or reuse one self-fix issue from app-visible failure](https://github.com/on-par/software-factory/issues/1392)
- [Epic #1379 — App-assisted factory self-healing](https://github.com/on-par/software-factory/issues/1379)
