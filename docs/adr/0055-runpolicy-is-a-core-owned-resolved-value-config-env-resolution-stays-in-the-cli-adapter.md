# ADR-0055: RunPolicy is a core-owned resolved value; config/env resolution stays in the CLI adapter

- Status: Accepted
- Date: 2026-08-27

## Context

Epic #670 (stories 2–6) is converging the CLI supervisor and the core simulator onto
shared core-owned value types. Story 1 (#672, ADR-0054) landed RunOutcome. shipIssue
still resolves factory.json + FACTORY_* precedence inline and threads ~500 lines of
separate locals (models/routes/factory config, EffectiveConfig, efficiency, sandbox
section), while sim/pipeline.ts builds parallel simModelsConfig()/simRoutesConfig()
stand-ins. There is no single shape for "what one run needs decided", so a future
server or Monte Carlo caller would have to re-implement file/env resolution to build
one. The forces: core must stay free of the CLI's config-loading and env precedence
(that adapter concern lives in the CLI), yet needs one resolved shape both the CLI and
the sim can populate and later stories can pass into a runIssue call.

## Decision

Introduce RunPolicy in packages/core/src/run/policy.ts as a plain resolved value object
— models config, routes config, the FactoryConfig sandbox section, a RunBudget cap, and
#668's EffectiveConfig — exported from core's root public API. RunPolicy performs no file
or env reads: file/env precedence resolution stays entirely in the CLI adapter, which
constructs a RunPolicy from its existing loaders. The simulator constructs its own
RunPolicy from its config stand-ins. This story only consolidates today's separate
locals into the value; wiring RunPolicy into an actual runIssue call is story 4.

## Consequences

Positive: one resolved-policy vocabulary in core that the CLI, sim, and future
server/Monte Carlo callers converge on; the core→CLI boundary stays acyclic; config
loading and env precedence stay isolated in the CLI adapter. Negative: RunPolicy and the
CLI's resolver code must be kept in agreement by convention — a future maintainer could
regress by adding config-loading logic into RunPolicy or by letting a new run-scoped
input skip the value; the shape test and the story-4 wiring guard against drift.

## References

- [Issue](https://github.com/on-par/software-factory/issues/673)
- [ADR-0054 — RunOutcome is a core-owned value type](https://github.com/on-par/software-factory/blob/main/docs/adr/0054-runoutcome-is-a-core-owned-value-type-park-classification-is-structural-not-instanceof.md)
