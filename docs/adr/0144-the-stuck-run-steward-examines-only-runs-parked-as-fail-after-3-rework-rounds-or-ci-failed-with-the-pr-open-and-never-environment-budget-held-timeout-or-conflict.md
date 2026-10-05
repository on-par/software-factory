# ADR-0144: The stuck-run steward examines only runs parked as fail after 3 rework rounds or ci-failed with the PR open, and never environment, budget, held, timeout or conflict

- Status: Accepted
- Date: 2026-10-05

## Context

The factory parks or releases runs for many reasons. `ParkReason` in `packages/core/src/run/outcome.ts` is `escalate | timeout | fail | conflict | ci-failed | held`. `RunOutcome` also has `released` with reason `environment` (#1928, ADR-0141). A steward that spends model budget on a parked run is only worth it when the run is stuck on its own change. Environment failures, budget breaches, cross-run holds, timeouts and conflicts need a human, an ops fix or a re-queue, not another agent pass. Without a written rule, later stories could hook the steward to any park event.

## Decision

The steward examines a run only when it matches one of the two triggers below, and never otherwise.

### Triggers

1. **CHECK failed after 3 rework rounds.** `checkPhase` used all `MAX_REWORK_ROUNDS` (3, `packages/core/src/phases/check.ts`) and CHECK still fails, so `runIssue` (`packages/core/src/run/run-issue.ts`) parks the run with reason `fail`.
2. **SHIP failed with the PR open or under watch.** SHIP opened the PR and the CI watch confirmed a failure or never reached green (`CiFailedError` / `CiUnverifiedError` in `packages/cli/src/cli/index.ts`), so the run parks with reason `ci-failed`.

### Non-triggers

- **Environment releases.** The outcome is `released` with reason `environment`, because every failing checker also fails on the base SHA (ADR-0141). The base is broken, not the change.
- **Budget parks.** The per-issue budget cap was exceeded (`budget_exceeded`, parked `fail`). These are excluded even though the reason is `fail`, because a steward pass would spend more of the exhausted budget.
- **Held.** Reason `held`. The same failure signature parked the issue in a prior run, and the issue needs a human decision.
- **Timeout.** Reason `timeout`. A phase exceeded its timeout, which is an ops or sizing problem.
- **Conflict.** Reason `conflict`. A merge conflict with the base branch needs a rebase, not a fix to the change.

### Packet

The steward receives one packet per triggered run. The packet is the model's only input. It is built from data the factory already holds, and every free-text item is capped. Each excerpt is first sanitized with `sanitizeEvidence` (ADR-0130). When an item is cut, the excerpt is shortened, never the surrounding structure, and the packet says what was cut in a visible note (the same rule as ADR-0131).

| Item                          | Contents                                                                                                                                   | Cap                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Run record                    | Issue number, run id, trigger (`fail` after rework or `ci-failed`), park reason, failure signature, rework round count                     | Fixed fields only, no free text                   |
| Issue                         | Issue title, and the body wrapped by `wrapUntrustedIssueBody` (ADR-0129)                                                                   | Title 256 chars, body 8000 chars                  |
| Failing checkers              | For each checker that failed in the last CHECK round: name, verdict and a `details` excerpt                                                | 10 checkers, 2000 chars each                      |
| Baseline comparison           | For each listed checker: the baseline verdict (`fails-on-base`, `clean-on-base`, `not-run`) and any `newFailingTests` (ADR-0141, ADR-0142) | 10 checkers, 20 test names each                   |
| Rework history                | For each rework round: the round number and its stuck signature                                                                            | 3 rounds (`MAX_REWORK_ROUNDS`)                    |
| Diff                          | The lane diff from the base SHA to the run head: a file list, then the unified diff                                                        | 200 files in the list, 20000 chars of diff        |
| CI failure (`ci-failed` only) | PR number, then for each failed or unverified required check: name, conclusion and a log excerpt                                           | 5 checks, 2000 chars each                         |
| Raw log pointer               | `host:path` of the local raw run log (ADR-0131)                                                                                            | One pointer. The raw log itself is never included |

The whole packet is capped at 48000 chars. If it is still over after every item cap, the diff is shortened first, then the checker excerpts. An item with no data (for example, CI failure on a `fail` trigger) is omitted, not sent empty.

### Output schema

The steward returns exactly one JSON object with these fields and no others:

| Field        | Type   | Rule                                                                                                                                                                       |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnosis`  | string | Why the run is stuck, in plain prose. Non-empty, at most 2000 chars.                                                                                                       |
| `nextStep`   | string | The single next step a human should take. Non-empty, at most 1000 chars.                                                                                                   |
| `confidence` | number | From 0 to 1 inclusive. The model's confidence that the diagnosis is correct.                                                                                               |
| `evidence`   | array  | 1 to 10 entries. Each entry is `{ item, quote }`: `item` names a packet item from the Packet table, and `quote` is a verbatim excerpt of at most 500 chars from that item. |

Evidence may cite only the packet. A quote that does not appear in the named item is invalid.

### Escalation

- A verdict with `confidence` below 0.90 is an escalation. An escalation recommends no action. It reports the diagnosis and evidence as unconfirmed and hands the run to a human. Its `nextStep` is not presented as a recommendation.
- A verdict with `confidence` of 0.90 or above is a recommendation. It still only recommends. The steward never acts on it (safety rules are in a later ADR).
- Output that is not valid JSON, lacks a field, has an extra field, has a `confidence` that is not a number from 0 to 1, or has evidence that fails the rules above is treated as an escalation with confidence 0. It is never retried as a recommendation.
- The 0.90 threshold is fixed by this ADR, not a config value.

Adding a trigger, removing a non-trigger, or changing a packet cap, an output field or the escalation threshold requires a new ADR that supersedes this one.

## Consequences

The steward never spends budget on environment, budget, hold, timeout or conflict states, and those keep their current human and ops paths. A `fail` park is a trigger only when it came from CHECK after the rework cap, so the steward must tell it apart from a budget `fail`. `escalate` parks (identical failures across rounds, ADR-0017 and stuck accounting) are not covered here and are left to the escalation story of #1942. Caps keep the steward's input bounded and predictable in cost, at the price of sometimes cutting the evidence that would have explained the failure. A cut is visible in the packet. Malformed or unsure output is treated as an escalation, so a confused model can only hand the run to a human, never push a low-confidence fix suggestion. The surface and safety rules are recorded in later ADRs.

References: #1984, #1987, parent #1942.
