# ADR-0139: A lane pauses after consecutive parks with the same failure signature, and pausing only stops claiming

- Status: Accepted
- Date: 2026-10-02

## Context

`factory run` lanes claimed the next queued issue straight after every park. When the base branch is broken, every issue in a lane fails CHECK the same way. The lane then parks the whole queue and spends model budget on each issue. CHECK now produces a stable failure signature (#1917), and `budget.laneBreakerThreshold` exists (#1915), so `runLane` can tell repeated identical failures apart from unrelated ones. Pausing must not lose queued work or touch labels on issues the lane never claimed.

## Decision

`runLane` (`packages/cli/src/cli/index.ts`) owns the lane circuit breaker. It counts consecutive parks that carry the same non-empty `LaneParkError.failureSignature`. A merged or awaiting-review issue resets the count. So does a park with a different, empty or missing signature, which includes non-`LaneParkError` failures and preflight parks. Skipped and decomposed issues leave the count unchanged. When the count reaches the threshold resolved by `resolveLaneBreakerThreshold` in `cmdRun`, `runLane` settles the tripping issue as parked, emits one `lane-paused` event with a `LanePausedPayload`, and returns. It does not emit `lane-done` and does not claim or release any other issue, so unclaimed issues keep `factory:queued`. A threshold of 0, or an absent `deps.laneBreakerThreshold`, disables the breaker. Breaker state is per `runLane` call and never spans lanes.

## Consequences

A broken base stops a lane after a small number of parks instead of draining its queue, and other lanes keep working. A paused lane only resumes on the next `factory run`. A coincidental signature match between two genuinely different changes pauses the lane too early. Telling a broken base apart from a broken change is left to #1907. Injected-deps callers get no breaker unless they pass a threshold.

References: #1918, parent #1906.
