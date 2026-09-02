# ADR-0078: SCBench workspaces carry a factory-authored generic constitution; briefs stay verbatim upstream

- Status: Accepted
- Date: 2026-09-02

## Context

SlopCodeBench's hidden evaluations deliberately test production-quality
behavior the visible checkpoint specs do not restate. The cfgpipe baseline
(PR #1176 / issue #1165) missed its last checkpoint at 75% because all three
checkpoint_4 trials failed exactly one Core test, test_sigint_shutdown — the
pinned spec never mentions signals, the upstream reference solution installs
SIGINT/SIGTERM handlers, and the workers wrote none. The factory's
differentiator is per-product constitutions injected into every phase, but
the adapter's prepareWorkspace gave benchmark workspaces no constitution, so
workers built to the literal spec text ("That is all you need to do", per
upstream's just-solve prompt). Two constraints shape where factory-side
standards may live: ADR-0008 pins problem inputs as data, so the brief must
remain the upstream task verbatim to keep the benchmark honest; and the
adapter invokes an external factory binary (FACTORY_BIN/PATH), so standards
shipped inside this repo's config package are not guaranteed to exist in the
binary that runs — the channel must be version-skew-safe.

## Decision

prepareWorkspace writes a factory-authored constitution to the SCBench
workspace's `.factory/constitution.md` on every call (idempotent overwrite),
with the content frozen as `WORKSPACE_CONSTITUTION` in
`packages/scbench-adapter/src/workspace-constitution.ts`. Core's
`ConstitutionLoader.resolve()` already treats a workspace's
`.factory/constitution.md` as the authoritative standards body, so the
standards reach PLAN/BUILD/CHECK without any brief, CLI, or config change,
and `.factory/`'s existing git exclusion keeps them out of SCBench diffs and
evaluation. The content is bound to generic engineering standards only —
process-lifecycle behavior (prompt, clean SIGINT/SIGTERM shutdown of
long-running modes; daemon or bounded-join threads; interruptible waits;
flushing stdout) and CLI hygiene (errors to stderr, spec-exact output). It
must never name a hidden test, quote a hidden assertion, or carry a
per-problem hint: strengthening it means adding a general engineering
standard, never a benchmark answer. materializeBrief and
materializeRetryBrief remain verbatim-upstream renderings.

## Consequences

Positive: benchmark runs now measure the factory with its standards
mechanism active, the same way real repos experience it; the fix generalizes
beyond cfgpipe (any hidden robustness expectation covered by a generic
standard benefits); the channel survives factory-binary version skew.
Negative: the constitution text becomes benchmark-sensitive surface —
editing it changes what future runs measure, so cross-run comparisons must
note the constitution revision in play, and content growth costs tokens in
every phase of every checkpoint; the generic-only rule means some hidden
expectations will still be missed by design, and that is accepted.

## References

- [Issue #1184: learn from cfgpipe checkpoint_4 miss](https://github.com/patrob/software-factory/issues/1184)
- [ADR-0008: problem inputs come from a pinned scb-problems revision](0008-slopcodebench-problem-inputs-come-from-a-pinned-scb-problems-revision-injected-via-scbench-problems-path.md)
