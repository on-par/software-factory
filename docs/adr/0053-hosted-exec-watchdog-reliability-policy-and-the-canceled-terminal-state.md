# ADR-0053: Hosted-exec watchdog reliability policy and the canceled terminal state

- Status: Accepted
- Date: 2026-08-26

## Context

#903 adds the first reliability controls to the hosted-exec control plane. Several policy
choices are load-bearing and would be expensive to reverse once runners and operators depend
on them: (1) how a canceled job is represented and whether cancellation is a lease-holder or
control-plane action; (2) whether a missed-heartbeat lease expiry is retryable while a hard
runtime-cap breach is a terminal failure; (3) how a dead-runner relaunch avoids duplicating
active work and when it stops retrying; and (4) what "the watchdog cannot safely fix this"
means and how it is surfaced. The issue explicitly flags retry-policy details as negotiable,
so the chosen policy must be recorded, not left implicit in the code.

## Decision

Cancellation is a control-plane action: `store.cancel(jobId, reason)` drives any non-terminal
job to a new `'canceled'` terminal status with a `HostedJobResult` outcome `'canceled'`, releases
the lease, and is idempotent — the runner learns of it cooperatively because its heartbeat
then returns `alreadyTerminal`. The watchdog draws a firm line: a missed-heartbeat lease expiry
returns the job to `'requested'` (retryable); exceeding `maxJobRuntimeMs` is a terminal failure
(fail-per-policy, not infinite retry). Dead-runner recovery force-reclaims the live lease so a
fresh runner relaunches without duplication — safe because the old lease is voided and its
holder can no longer finalize — and is bounded by `maxRelaunches` derived from the count of
`'leased'` events. When a stuck active run exceeds that bound, the watchdog does not auto-fix it;
it emits a `WatchdogEscalation` (jobId, status, reason, bounded recentEvents tail, manual path),
keeping auto-fixable dead runners strictly distinct from cases needing human intervention.

## Consequences

Positive: every failure mode has a defined, testable terminal or retryable outcome; stuck and
orphaned jobs cannot accumulate silently; operators get a concise, secret-free escalation
surface. Negative: the runtime cap and relaunch bound are fixed policy knobs that some jobs
will hit legitimately; cancellation is cooperative (no mid-run container kill yet), so a
wedged runner is only reclaimed on the next lease expiry or watchdog sweep, not instantly.

## References

- [ADR-0048 — hosted job store is an in-memory, clock-injected control-plane store with fixed idempotency check ordering](docs/adr/0048-hosted-job-store-is-an-in-memory-clock-injected-control-plane-store-with-fixed-idempotency-check-ordering.md)
- [ADR-0049 — hosted-exec container execution runs behind an injected ContainerEngine port](docs/adr/0049-hosted-exec-container-execution-runs-behind-an-injected-containerengine-port.md)
- [Issue #903](https://github.com/on-par/software-factory/issues/903)
