# ADR-0069: Baseline provider policy is pinned as literal data and confirmed only from recorded model attempts

- Status: Accepted
- Date: 2026-09-01

## Context

Issue #1132: `evals/scbench-baseline/baseline.config.json` cited the deleted
`packages/config/src/models.json`/`routes.json` as the model/route source, and
neither the config nor the generated report said which models were approved for
the Claude-only benchmark posture or whether Ollama stayed disabled. ADR-0007
already established that baseline correctness is fail-closed on retained
evidence, and ADR-0008 that pinned inputs are recorded as literal data, never as
rules evaluated at run time. Provider posture needed the same treatment: a
reviewer must be able to check the declared policy against per-run evidence
without trusting a self-report, and the committed smoke trials carry no
recorded model attempts at all, so the reporting rule had to decide what
absence of routing evidence means.

## Decision

`baseline.config.json` declares `providerPolicy` as data: `approvedModels` is a
literal list of model ids (the Claude/Fable set) and `disabledProviders` names
the providers that must not run (`ollama`). `modelConfig.source` names the
current config module (`packages/config/src/defaults.ts`), and
`BaselineConfigSchema` rejects any source string referencing the deleted
`models.json`/`routes.json`, so stale provenance cannot load. The report's
"Provider policy" section derives run evidence exclusively from each trial
manifest's `modelAttempts`: the Ollama-disabled verdict is "confirmed" only
when every trial recorded at least one attempt and every observed model is in
the approved set; any unapproved model renders NOT CONFIRMED; any trial with no
recorded attempts renders "not confirmable". Absence of routing evidence is
never rendered as confirmation.

## Consequences

Positive: provider posture is reviewable end to end — declared policy in the
pinned config, observed models in retained manifests, verdict derived by code —
and reintroducing deleted-file provenance fails schema validation and tests.
Negative: the existing committed smoke trials, which recorded no model
attempts, render "not confirmable" rather than a comforting "confirmed", and
every future baseline config must carry a providerPolicy block and keep its
approvedModels literals in step with the intended posture by hand.

## References

- [Issue #1132](https://github.com/on-par/software-factory/issues/1132)
- [ADR-0007 — baseline correctness derives only from retained native evidence](../adr/0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)
- [ADR-0008 — pinned problem inputs are data, not rules](../adr/0008-slopcodebench-problem-inputs-come-from-a-pinned-scb-problems-revision-injected-via-scbench-problems-path.md)
