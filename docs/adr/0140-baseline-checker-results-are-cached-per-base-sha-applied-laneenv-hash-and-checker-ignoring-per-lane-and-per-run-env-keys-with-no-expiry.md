# ADR-0140: Baseline checker results are cached per base SHA, applied-laneEnv hash and checker, ignoring per-lane and per-run env keys, with no expiry

- Status: Accepted
- Date: 2026-10-03

## Context

CHECK re-runs round-1 failing checkers on the base SHA in a temporary worktree (#1925) to tell
pre-existing failures from new ones. Issues in one lane usually share a base SHA, so the same
slow base run was repeated per issue. A base result depends on the commit, the checker, and
the environment the factory applies (laneEnv). laneEnv also carries values that differ for
every issue or run but do not describe the environment's contract: the port lease
(PORT, FACTORY_APP_PORT, FACTORY_BASE_URL) and .NET's SharedCompilationId=factory-<runId>.
Hashing those would make every key unique and the cache useless.

## Decision

`runBaselineCheckers` (packages/core/src/checkers/baseline.ts) consults `BaselineCache`
(packages/core/src/checkers/baseline-cache.ts), stored at state/baseline-cache.json
(`getFactoryPaths().baselineCache`). The key is the base SHA, `hashBaselineEnv(ctx.env)`, and
the checker name. `hashBaselineEnv` is the single owner of the env key: the first 16 hex
characters of the SHA-256 of the sorted laneEnv entries, after dropping the keys in
`BASELINE_ENV_VOLATILE_KEYS` (PORT, FACTORY_APP_PORT, FACTORY_BASE_URL, SharedCompilationId).
Only PASS and FAIL base results are stored; SKIPs and errored runs are not. Entries never
expire. Any cache read or write error is treated as a miss and never fails CHECK.

## Consequences

A lane runs each failing checker on a given base and environment once, not once per issue.
An environment fix changes the hash and forces a fresh base run. A new laneEnv key that is
per-lane or per-run must be added to BASELINE_ENV_VOLATILE_KEYS, or the cache stops hitting
across issues. A result that depends on the port value or on flaky base state is reused
until the base SHA or environment changes. The file grows without bound until expiry or
pruning is added later. Concurrent lanes may overwrite each other's writes, which only
causes a later re-run.

## References

- [Issue](https://github.com/on-par/software-factory/issues/1926)
