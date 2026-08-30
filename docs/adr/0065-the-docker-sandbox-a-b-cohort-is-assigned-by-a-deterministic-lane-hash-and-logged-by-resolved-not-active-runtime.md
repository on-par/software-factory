# ADR-0065: The docker-sandbox A/B cohort is assigned by a deterministic lane hash and logged by resolved, not active, runtime

- Status: Accepted
- Date: 2026-08-30

## Context

Epic #655 must gather cost/duration/rework evidence comparing the new docker-sandbox
runtime (#652) against today's default before the default is changed. Two facts make
the instrumentation non-obvious. First, docker-sandbox has no VM lifecycle yet (#653),
so a lane "assigned" to it actually runs uncontained — the cohort label therefore
cannot be derived from the ACTIVE SandboxPolicy (which is undefined for such a lane)
and must come from the RESOLVED runtime. Second, the assignment must be reproducible
and must not perturb the existing auto/FACTORY_SANDBOX_RUNTIME resolution an operator
relies on. Cost rows are also streamed per model call, before a run's final rework
count is known.

## Decision

Each `.factory/costs.jsonl` entry gains `sandboxRuntime` (the resolved runtime name,
including docker-sandbox even when uncontained), `duration` (router-measured wall-clock
ms of the model call), and `reworkRoundCount` (rework rounds completed at emission time;
a run's total is the max over its rows). A new `sandbox.docker.rolloutPercent` (default
0) drives a pure `resolveRolloutRuntime(laneId, rolloutPercent)` that hashes the lane ID
(FNV-1a) into a 0..99 bucket and promotes in-bucket lanes to docker-sandbox. The rollout
only fires when the runtime is unpinned (config runtime is 'auto' and no
FACTORY_SANDBOX_RUNTIME), so it reallocates only the auto cohort and never overrides an
explicit operator choice.

## Consequences

Positive: #656 can group merged runs by sandboxRuntime and compute per-cohort cost,
duration, and rework figures from the cost log alone; the assignment is deterministic
and reproducible; the shipped default (rolloutPercent 0) and every explicit-pin path are
behaviorally unchanged. Negative: docker-sandbox-labeled lanes currently run uncontained,
so a cohort's containment differs from its label until #653 lands; reworkRoundCount is a
running (not final) value on each row, so consumers must reduce with max per run rather
than read any single row.

## References

- [Issue](https://github.com/on-par/software-factory/issues/655)
- [PR #652 — docker-sandbox as a SandboxRuntime](https://github.com/on-par/software-factory/pull/1011)
