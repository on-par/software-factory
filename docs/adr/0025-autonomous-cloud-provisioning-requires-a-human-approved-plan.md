# ADR-0025: Autonomous cloud provisioning requires a human-approved plan gate

- Status: Accepted
- Date: 2026-08-14

## Context

The factory ships code autonomously (ADR-0001 boss-worker-checker; ADR-0005
autonomous loops), and #625/#626 established that its cloud-provisioning
direction is IaC with a plan/diff surface — CDK + CloudFormation change sets and
`cdk diff` on AWS; Bicep/ARM with `az deployment group what-if` on Azure;
`terraform plan -out` as the cross-provider fallback — and scoped, short-lived
federated credentials. Unlike a bad code PR, which is cheap to undo, a bad
provisioning action creates ongoing cost (an idle GPU instance, an oversized
database) and lasting security exposure (an over-permissive IAM role, a
publicly-exposed resource) that keeps costing money after the agent has moved
on. The #624 audit documented the precedent in this org's own pipelines: App
Store Connect app-record creation and app-specific-password generation stayed
human-gated even in otherwise fully autonomous pipelines, and sound-buddy's
release used draft-then-promote plus a confirmation prompt before any publish.
The factory already owns the enforcement machinery this decision reuses: an
`ApprovalGate` seam with a `plan` approval kind and fail-safe deny on timeout
(`packages/core/src/approvals/index.ts`: `ApprovalRequest` `kind?: 'ship' |
'plan'` and `specPreview` at index.ts:20-23, the gate at index.ts:35, the
file transport at index.ts:51-83, timeout deny at index.ts:76-81), and a
cost-KPI machinery that measures per-merge cost (ADR-0020, `.factory/costs.jsonl`
resolved at `packages/core/src/config/index.ts:403`). The gate decision
constrains how the future provisioning implementation must be written and would
be expensive to reverse once autonomous provisioning ships, so it is recorded
per `docs/adr/README.md`.

## Decision

Any provisioning action that creates billable or internet-facing infrastructure
requires a mandatory human plan-approval gate: **PLAN** (produce the IaC
plan/diff and a cost estimate for the action) then **APPROVE** (a human, through
the existing `ApprovalGate` seam via a new `provision` approval kind, fail-safe
deny on timeout) then **APPLY** — an apply step may not run without an approved
plan. The blast-radius classification is binding: only **Class A** actions —
throwaway preview environments with an enforced N-hour teardown, a non-production
endpoint, a cost estimate under the autonomous ceiling, and no
IAM/credential/role mutation — may run without a per-action human approval, and
even those still produce and apply a plan (autonomy is about the approval step,
never about planning). Everything else — production infrastructure, anything
with persistent cost, internet-facing resources that are not approved ephemeral
previews, and any IAM/credential change — always requires human approval. Cost
ceilings are enforced at plan time by refusing to apply above a config-declared
per-action ceiling, with cloud-native budget cost-actions and fail-closed
provider policy (SCP / Azure Policy) as backstops; ceiling values live in config
and are calibrated by the ADR-0020 cost KPIs.

## Consequences

Positive: provisioning blast radius is bounded by construction — the most
expensive autonomous mistake is a TTL-capped, under-ceiling preview environment,
and nothing billable or internet-facing is created without a human having
approved the plan that creates it. Negative: every billable or internet-facing
action carries a human round-trip (the lane parks or queues until approval), the
plan payload must carry a trustworthy cost estimate, and the follow-up
implementation must build the `provision` approval transport and the plan-time
cost check. The #625/#626 tool pick (CDK vs. Bicep vs. Terraform) is
deliberately left undecided; the gate applies regardless of which is chosen.

## References

- [docs/research/cloud-provisioning-guardrails.md (#627, this PR)](../../docs/research/cloud-provisioning-guardrails.md)
- [docs/research/aws-deployment-automation.md (#625)](../../docs/research/aws-deployment-automation.md)
- [docs/research/azure-deployment-automation.md (#626)](../../docs/research/azure-deployment-automation.md)
- [docs/research/deployment-automation-audit.md (#624)](../../docs/research/deployment-automation-audit.md)
- [packages/core/src/approvals/index.ts (ApprovalGate seam)](../../packages/core/src/approvals/index.ts)
- [ADR-0020 (cost KPIs)](0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md)
