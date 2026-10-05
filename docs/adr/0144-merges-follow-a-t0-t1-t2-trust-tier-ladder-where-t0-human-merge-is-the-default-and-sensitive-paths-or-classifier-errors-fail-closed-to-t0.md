# ADR-0144: Merges follow a T0/T1/T2 trust tier ladder where T0 human merge is the default and sensitive paths or classifier errors fail closed to T0

- Status: Accepted
- Date: 2026-10-05

## Context

ADR-0121 fixes who may approve (the classifier routes, it does not approve), the A/B/C review classes,
the deterministic floor (`packages/core/src/review/floor.ts`, `DEFAULT_REVIEW_FLOOR_RULES`; final class =
max(floor, model), A < B < C) and a staged rollout. It does not say how often a human must click merge.

ADR-0127 already makes every merge path refuse a PR or issue carrying the `no-auto-merge` label
(`selfFixLabel` in `packages/config/src/defaults.ts`), fail closed on unreadable labels, and allow only
`factory land --allow-gated` with an audit record.

Without a written ladder, "auto-merge" means different things in different places and the safe default
is implicit.

## Decision

Merges follow three tiers:

| Tier | Meaning                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| T0   | A human merges every eligible PR. No PR merges without a human click. This is the default.                                 |
| T1   | Eligible PRs auto-merge, except a deterministic sample held back for a human. Sampled PRs carry the `no-auto-merge` label. |
| T2   | Eligible PRs auto-merge with no human click, still behind every required CI check and every policy gate.                   |

T0 is the default tier for every repo and every class until a human-merged policy change moves a class up.

**T1 sampling.** The sample is chosen deterministically from PR facts, for example a stable hash of the
diff SHA against the configured rate. The same PR always gets the same decision, so the sample cannot be
steered. Each sampled PR gets the `no-auto-merge` label, so ADR-0127's gate holds it until a human merges it.

**T2 gates.** T2 keeps the fail-closed CI gate (ADR-0014, `main` must stay green), the ADR-0127
`no-auto-merge` gate, the ADR-0121 rollout stage and fork containment (ADR-0114).

**Eligibility.** A PR is eligible for a tier above T0 only when both hold:

1. Its classifier class (the final class per ADR-0121) is a class the policy has promoted to that tier.
2. Every changed path is allowed by the path rules for that tier.

Neither alone is enough. A tier never loosens a class: Class B and C still need human approval per
ADR-0121, so in practice only promoted Class A categories (docs-only, tests-only today) can sit above T0.

**Fail closed to T0.**

- A PR that touches any sensitive path resolves to T0. Sensitive paths are the floor's Class C rules
  (workflows, merge and land code, classifier and review policy, security, auth, credential, token and
  secret names, dependency manifests and lockfiles) plus any the repo policy adds.
- Any classifier error (timeout, parse failure, missing input, unknown class) resolves to T0.
- An unknown or unreadable tier setting, or a PR whose labels cannot be read, resolves to T0.
- Tier resolution only ever lowers to T0 on doubt. It never raises.

**Scope.** This ADR defines the ladder and eligibility only. How a class earns promotion to T1 or T2, and
when it is demoted, are left to a later ADR. ADR-0121's classes and rollout are unchanged.

## Consequences

- One vocabulary for merge frequency, and the safe default is explicit.
- T1 sampling is reproducible and auditable, and reuses the existing `no-auto-merge` gate instead of a new mechanism.
- The T0 default keeps human merge load high until promotions land.
- Deterministic sampling is predictable. This is accepted, since the agent cannot steer the sampled set.
- Eligibility needs both a class check and a path check, so code implementing tiers must evaluate both.
