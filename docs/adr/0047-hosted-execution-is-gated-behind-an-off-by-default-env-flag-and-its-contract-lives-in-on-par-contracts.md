# ADR-0047: Hosted execution is gated behind an off-by-default env flag and its contract lives in @on-par/contracts

- Status: Accepted
- Date: 2026-08-26

## Context

Parent epic #895 introduces a new hosted (remote-runner) execution
architecture that will land across many stories. Committing the repo to
that architecture up front is risky, and later stories need a stable
shared vocabulary plus a proven safety switch so they can land
incrementally without ever changing the default local path. The repo's
existing binary safety switches (FACTORY_LOCAL_ONLY, FACTORY_MERGE,
FACTORY_EXPERIMENTAL) are all `FACTORY_<NAME>=1` env vars, and
@on-par/contracts is already the designated home for cross-boundary zod
schemas + inferred types (AGENTS.md). The zero-dependency config package
and core's FactoryConfigSchema are deliberately kept lean.

## Decision

Gate the entire hosted-execution feature behind the environment flag
FACTORY_HOSTED_EXEC, read only through the pure helper
hostedExecEnabled(env), which returns true only when the value is exactly
"1" and false (feature off) for every other/absent value. Locate the
hosted contract — HostedJobRequest, RunnerLease, HostedJobEvent (schemas +
inferred types) — in @on-par/contracts. Every future hosted-exec story
MUST consult this flag before constructing any hosted runner path and MUST
build on these schemas rather than introducing parallel shapes or a
separate config toggle. When the flag is off, no hosted code path may be
constructed and the local factory path stays the default.

## Consequences

Positive: later stories inherit one language and one off-switch; the local
path is provably unchanged while the feature is off; the flag choice keeps
the zero-dep config package and core's config schema untouched; naming can
still evolve while the flag is off. Negative: an env flag is process-global
and not expressed in factory config JSON, so it is less discoverable than a
config field; the contract fields are a forward commitment that future
stories should extend additively rather than reshape.

## References

- [Parent epic](https://github.com/on-par/software-factory/issues/895)
- [Issue](https://github.com/on-par/software-factory/issues/896)
