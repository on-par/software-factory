# Provider-agnostic deployment automation for factory-built apps (Issue #628)

Date: 2026-08-14

## Purpose and scope

This is the #628 discovery document that settles the approach the factory uses to
deploy factory-built apps to a cloud provider. It consumes the four landed
inputs — the #624 deployment-automation audit
(`docs/research/deployment-automation-audit.md`), the #625 AWS research
(`docs/research/aws-deployment-automation.md`), the #626 Azure research
(`docs/research/azure-deployment-automation.md`), and the #627 provisioning
guardrails (`docs/research/cloud-provisioning-guardrails.md`, ADR-0025/0026) —
and makes ONE recommendation: **standardize on a single provider-agnostic IaC
layer — Terraform, with Pulumi (TypeScript) as the tracked alternative — over
hand-rolled provider-specific code paths.** It then folds #627's guardrails in
as **non-negotiable requirements** the chosen approach must satisfy, outlines a
minimal spike that proves the approach under those requirements, and gives the
spike an explicit go/no-go decision point.

It is a **discovery artifact, not a design**: it makes no final binding pick and
adds no ADR — the binding ADR for the final pick is written at the spike's go
decision, in the follow-up implementation story, exactly as #625 and #626
deferred theirs (`aws-deployment-automation.md:246-250`,
`azure-deployment-automation.md:263-267`). The #627 guardrails are already
binding (ADR-0025/0026); this document does not revisit or relax them. It
implements nothing: no code, no config, no IaC stack, no deploy lane — the
spike is planned here and run by a follow-up story.

This issue is distinct from #620 (hosting the factory's own orchestration),
which is out of scope. Every claim about this checkout is grounded in a
`file:line` citation; external cloud facts (provider service behavior, budget
cost-action semantics, Terraform/Pulumi backend details) are **approximate and
volatile as of the `Date:` line** and must be re-verified before the follow-up
implementation commits to a mechanism.

## What the four landed docs already settled (the inputs to this recommendation)

The four docs consumed by this issue already decided most of the shape; this
document's recommendation has to fit inside what they settled rather than
re-derive it.

- **#624 — the audit: three patterns to reuse, not re-derive.** Every audited
  on-par pipeline already contains a working answer to "who holds the secret,
  who approves the action, and what it costs" — credential handoff
  (`deployment-automation-audit.md`, "Credential handoff"), plan-then-approve
  (draft-then-promote, confirmation prompts, fail-closed signing gates;
  `deployment-automation-audit.md`, "Plan-then-approve"), and cost awareness
  (ADR-0020 KPIs, deferral lists; `deployment-automation-audit.md`,
  "Cost awareness"). The audit's finding: the deployment design should reuse
  these three patterns, not re-derive them
  (`deployment-automation-audit.md:373-380`).
- **#625 — AWS: IaC over raw `aws` CLI; Terraform named the multi-cloud
  fallback.** Raw `aws` CLI fails state tracking, drift detection, planning,
  and idempotency (`aws-deployment-automation.md:55-81`). For an AWS-only story
  CDK is recommended over Terraform/Pulumi because CloudFormation owns the
  state; **Terraform/Pulumi "become the fallback only if the factory later
  needs multi-cloud"** (`aws-deployment-automation.md:230-250`). ECS/Fargate is
  the compute direction (`aws-deployment-automation.md:166-170`).
- **#626 — Azure: IaC over raw `az` CLI; the cross-provider trade-off spelled
  out.** Raw `az` CLI fails the same gaps (`azure-deployment-automation.md:60-88`).
  For an Azure-only story Bicep is recommended over Terraform; **Terraform
  becomes the fallback if the cross-provider call goes multi-cloud**
  (`azure-deployment-automation.md:248-267`). The explicit cross-provider
  section names the trade this issue decides: one tool (Terraform/Pulumi) buys
  one control plane + one state model across both providers at the cost of both
  providers' native tooling; provider-native both ways (Bicep + CDK) means two
  tools, two state models, and two identity models, each simplest in its own
  provider (`azure-deployment-automation.md:269-311`). #626 deliberately does
  not make the call (`azure-deployment-automation.md:306-311`).
- **#627 — the guardrails: tool-independent, already binding.** The mandatory
  PLAN → APPROVE → APPLY gate, plan-time cost ceilings with a four-rung
  enforcement ladder, the Class A/B blast-radius classification, scoped
  short-lived never-committed federated credentials, and config-as-source-of-
  truth ceilings — all hold whichever #625/#626 pick lands
  (`cloud-provisioning-guardrails.md:90-267`; ADR-0025, ADR-0026). Critically,
  #627 names `terraform plan -out` as one of the cross-provider plan surfaces
  the gate reuses (`cloud-provisioning-guardrails.md:47-51`), and the ADRs
  deliberately leave the #625/#626 tool pick open (ADR-0025:61-62,
  ADR-0026:52-53).

## The decision this issue settles

The issue narrows one decision the four inputs deferred: **hand-rolled
provider-specific code paths vs. one provider-agnostic IaC layer.** Define the
two poles precisely:

- **Provider-specific code paths.** Per-repo, per-provider hand-rolled
  automation — either raw `aws`/`az` CLI scripts (already rejected by both
  #625 and #626 for no state tracking, no drift detection, no plan/diff, and no
  teardown; `aws-deployment-automation.md:55-81`,
  `azure-deployment-automation.md:60-88`) or provider-native IaC both ways (CDK
  for AWS repos + Bicep for Azure repos). The provider-native-both-ways variant
  keeps each provider's simplest tooling but makes the factory operate **two
  tools, two state models, two identity models, and — decisive under #627 —
  two plan/approve/apply seams**, so the mandatory human gate and plan-time cost
  ceiling must be built and maintained twice, and the deploy-story format forks
  per provider (`azure-deployment-automation.md:306-311`).
- **Provider-agnostic IaC layer.** One tool that happens to target either
  provider: one repo-owned stack shape, one deploy cycle, one plan/approve/apply
  seam, one state model, one credential story. Within this pole, **Terraform**
  is the recommendation, with **Pulumi (TypeScript)** the tracked alternative.

### Recommendation: provider-agnostic IaC, Terraform

The recommendation is synthesized from the four landed inputs, not argued from
scratch:

1. **Both #625 and #626 independently converged on "IaC over raw CLI either
   way" and both named Terraform the cross-provider fallback.**
   (`aws-deployment-automation.md:230-250`, `azure-deployment-automation.md:248-259`).
   This issue upgrades Terraform from fallback to recommendation because the
   factory's deployment targets ARE multi-provider: the app's provider is a
   per-product variable, so the "no multi-cloud need" premise that favored
   provider-native tooling in the single-provider AWS-only / Azure-only stories
   is false at the factory level.
2. **The factory is multi-provider by design.** Model routing is config-driven
   multi-provider routing with automatic failover — `packages/config/src/models.json`
   (registry, models.json:3) and `packages/config/src/routes.json` (tier
   routing, routes.json:3). A uniform, provider-agnostic deploy mechanism is
   the same philosophy, not a new one: the factory already treats the provider
   of its model inference as a per-product variable, and the deploy mechanism
   should treat the provider of its apps the same way.
3. **One deploy-story format means #627's gate is built once.** The mandatory
   PLAN → APPROVE → APPLY gate and the plan-time cost ceiling must be threaded
   through a single plan surface. `terraform plan -out` is #627's own named
   cross-provider plan surface (`cloud-provisioning-guardrails.md:47-51`), so
   one provider-agnostic layer gives one seam to extend with the `provision`
   approval kind — instead of building the gate machinery twice, once per
   provider-native toolchain. This is the decisive point: the guardrails are
   tool-independent, but their enforcement cost is proportional to the number
   of plan/apply surfaces the factory operates.
4. **The honest cost — and why it is the spike's job to validate.** HCL is a
   new language in a TypeScript-only monorepo, and Terraform's state backend is
   an operational burden the factory must own: where it lives, who locks it,
   how a second lane avoids stomping the first — the ADR-0009 locking problem
   restated at the infrastructure layer (`azure-deployment-automation.md:112-125`,
   ADR-0009). Pulumi (TypeScript) is the tracked alternative that preserves the
   approach if the spike shows the HCL/state burden is decisive; the spike's
   go/no-go is designed to weigh exactly this.

### The provider-agnostic deploy story format

The recommendation standardizes on a deploy story format that is independent of
the provider the app happens to target:

- **One repo-owned provider-agnostic stack** — a per-app configuration,
  provider-targeted at apply time, defining the compute target, the container
  registry, a reachable endpoint, and a health check.
- **A deploy cycle that fits a factory lane** — build image → push to registry
  → plan/diff (`terraform plan -out`) → human approve → apply → verify health →
  enforced TTL teardown (`terraform destroy`), repeatable and cleanly reversible.
- **Scoped, short-lived federated credentials, injected env-only** — never
  committed, never baked into an image (see R4 below).

This is the format #625 and #626 each already sketched for their single-provider
stories (`aws-deployment-automation.md:213-228`,
`azure-deployment-automation.md:230-246`); the recommendation makes it the ONE
format instead of two provider-forked ones.

## #627's guardrails as non-negotiable requirements

Each #627 guardrail is restated here as a **hard requirement** the chosen
approach must satisfy, with its concrete enforcement mechanism. The spike below
is the test that these requirements actually hold end to end; a failure on any
of them is a NO-GO.

### R1 — PLAN → APPROVE → APPLY gate for any billable or internet-facing action

The gate is **structural, not advisory**: an apply step cannot run without an
approved plan. It is enforced through the existing `ApprovalGate` seam —
`ApprovalRequest` with `kind?: 'ship' | 'plan'` and `specPreview`
(`packages/core/src/approvals/index.ts:12-25`), the `ApprovalGate` seam at
index.ts:35, and the file transport `createFileApprovalGate` which **fails
closed on timeout**: after `timeoutMs` without a response it returns
`{ approved: false }` (index.ts:51-83, deny at index.ts:76-81). The follow-up
implementation extends the seam with a **`provision` approval kind** whose
payload carries the plan/diff summary and the R2 plan-time cost estimate; the
apply step runs only after a `{ approved: true }` response, and a lane that
never gets one denies by default. This is the same fail-safe-deny posture the
seam already guarantees, applied to a `provision` kind
(`cloud-provisioning-guardrails.md:184-197`).

### R2 — Plan-time cost ceilings, with the enforcement ladder

The plan/diff is cost-estimated (resource shape: instance class/size, replica
count, region, storage, expected uptime) and compared against config-declared
per-action ceilings; **over-ceiling plans are refused before apply**. The four-
rung ladder holds regardless of tool pick: (1) plan-time refusal is primary and
costs nothing extra because it consumes the plan the gate already produces; (2)
cloud-native budget cost-actions are the asynchronous backstop (coarse,
after-the-fact — which is why they are not the primary gate); (3) fail-closed
provider policy (SCP / Azure Policy deny-lists) is the belt-and-suspenders rung
that holds when the estimate is wrong or credentials are hijacked; (4) ceiling
values are calibrated by the ADR-0020 cost KPIs, not chosen arbitrarily
(`cloud-provisioning-guardrails.md:109-171`).

### R3 — Blast-radius classification

A mechanical decision procedure with explicit axes (billability/persistence,
internet exposure, production vs. throwaway, TTL guarantee, IAM/credential
mutation). **Class A** — throwaway preview with enforced N-hour teardown,
non-production endpoint, plan-time estimate under the autonomous ceiling, no
IAM/credential/role mutation — may run without per-action human approval (but
never without a plan). Everything else is **Class B** — always human-approved
(`cloud-provisioning-guardrails.md:218-270`). The spike below is deliberately
scoped to stay Class A, so it exercises the autonomous-eligible path; Class B
remains human-approved by construction.

### R4 — Scoped, short-lived, never-committed federated credentials

Per-lane/per-run federated credentials (AWS `sts:AssumeRole` + web-identity/OIDC;
Azure workload identity federation), injected **env-only** via `leaseEnv`
(`packages/core/src/environment/index.ts:299-305` — `PORT` /
`FACTORY_APP_PORT` / `FACTORY_BASE_URL` at index.ts:301-303) and the
`HarnessRequest.env` seam (`packages/core/src/harness/index.ts:45-46`). They are
never written to a repo file, never baked into an image, never a `.env` or a
persisted CLI profile — consistent with the existing credential scrubber
(`CREDENTIAL_BASENAMES` at `packages/core/src/utils/worktree-gc.ts:42`,
`findCredentialFiles` at worktree-gc.ts:77). Paired with the egress reality —
the sandbox inherits the host env (`packages/core/src/utils/exec.ts:57`,
exec.ts:141) and egress is open by default until the allowlist is enforced
(`packages/core/src/sandbox/index.ts:114`, sandbox/index.ts:138; the shipped
default is a non-empty allowlist, `packages/config/src/factory.json:59`) — this
scoping is a **hard prerequisite of any provisioning story**, not a follow-up
hardening step (`cloud-provisioning-guardrails.md:53-74`).

### R5 — Config-as-source-of-truth ceilings

Ceilings, budgets, and provider configuration live in config, not constants in
core — the `models.json`/`routes.json` precedent (`packages/config/src/models.json:3`,
`packages/config/src/routes.json:3`). Ceiling defaults are calibrated from what
the factory actually measures (ADR-0020, `.factory/costs.jsonl` resolved at
`packages/core/src/config/index.ts:403`); they are never buried in the
implementation.

## The minimal spike

The smallest real thing that proves the chosen approach works under the
requirements above. It is planned here and **run by a follow-up story** — this
PR ships no implementation.

- **Goal (concrete, end-to-end):** provision and tear down ONE throwaway
  preview environment for ONE real app on ONE provider, exercising the full
  cycle under the #627 gate: **PLAN** (repo-owned provider-agnostic stack +
  `terraform plan -out` + plan-time cost estimate vs. the config-declared
  ceiling) → **APPROVE** (the human approval gate, in the middle — through the
  existing `ApprovalGate` seam via the `provision` kind, fail-safe deny on
  timeout, so no apply runs without an approved plan) → **APPLY** (`terraform
apply` of the approved plan) → **VERIFY** (health check against the preview
  URL) → **TEARDOWN** (enforced N-hour TTL → `terraform destroy`, then verify no
  lingering billable resources via `terraform show` / provider console).
- **App selection:** one real factory-built containerized TypeScript web app,
  chosen at spike start by the criterion "smallest containerized web service
  the factory already ships" — the build artifact is a container per ADR-0023.
  The factory dashboard (`@on-par/factory-dashboard`, a Vite + React + Tailwind
  walking skeleton) is the concrete candidate: it is a real web service the
  factory already builds, small enough to provision and tear down cheaply, and
  private (never the product surface of a live customer).
- **Provider:** ONE provider only — the spike proves the provider-agnostic
  claim on a single provider; the second provider is a follow-up after the go
  decision. Which provider is chosen at spike start based on operator access;
  the recommendation holds either way because the stack is provider-agnostic.
- **Scope constraints (stays Class A):** throwaway preview, non-production
  endpoint, enforced N-hour TTL, plan-time cost estimate under the autonomous
  ceiling, no IAM/credential/role mutation, no production resources, no
  persistent environment, no second provider. Credentials are the R4 scoped
  short-lived federated kind, env-only.
- **Success criteria (what "proves the chosen approach works"):**
  1. the environment was created **only after a human approved the plan**
     (R1: the apply step cannot run without an approved plan);
  2. the environment came up and answered a health check (VERIFY passed);
  3. teardown **provably removed all billable resources** — verified, not
     assumed (R1's teardown half: the destroy step is itself Class A);
  4. the entire cycle used only the provider-agnostic toolchain — **zero raw
     `aws`/`az` scripting** (the #625/#626 rejection holds in practice);
  5. total cost stayed **under the config-declared ceiling** with the budget
     backstop armed (R2, R5).

## The go/no-go decision point

- **GO** — the spike completes the full cycle (plan → approve → apply → verify
  → teardown) with the #627 gate intact, under the ceiling, with verified
  teardown → **proceed to the follow-up implementation story**, which builds the
  real capability and is **where the binding ADR for the final pick is
  written** (the #625/#626 deferral convention,
  `aws-deployment-automation.md:246-250`, `azure-deployment-automation.md:263-267`).
- **NO-GO** — any of: the gate cannot be threaded through the toolchain
  (plan → approve → apply cannot be structurally enforced on a provider-agnostic
  layer); teardown does not provably release billable spend; cost exceeds the
  ceiling; or the Terraform tooling burden (HCL / state backend) outweighs the
  single-mechanism benefit → **re-evaluate before any implementation**: Pulumi
  as the TypeScript alternative (same approach), or provider-native both ways.
- **Where the verdict lands:** the spike's evidence and the go/no-go verdict
  are recorded back into this document (a spike-results addendum) so the
  decision is traceable.

## Sources

All URLs retrieved on the `Date:` line; external facts (provider service
behavior, budget cost-action semantics, Terraform/Pulumi backend behavior) are
**approximate and volatile** and must be re-verified before the follow-up
implementation commits to a mechanism.

- Terraform — state (explicit state file, remote backends with locking):
  https://developer.hashicorp.com/terraform/language/state
- Pulumi — state and backends (Pulumi Cloud / self-hosted):
  https://www.pulumi.com/docs/concepts/state/
- #624 — `docs/research/deployment-automation-audit.md` (the three reusable
  patterns: credential handoff, plan-then-approve, cost awareness).
- #625 — `docs/research/aws-deployment-automation.md` (IaC over raw `aws` CLI;
  CDK for the AWS-only story; Terraform/Pulumi named the multi-cloud fallback;
  ECS/Fargate compute direction; credential scoping; minimal deploy story).
- #626 — `docs/research/azure-deployment-automation.md` (IaC over raw `az` CLI;
  Bicep for the Azure-only story; Terraform named the multi-cloud fallback; the
  cross-provider trade-off at azure-deployment-automation.md:269-311; Container
  Apps compute direction; credential scoping; minimal deploy story).
- #627 — `docs/research/cloud-provisioning-guardrails.md` (the guardrails this
  document restates as requirements; `terraform plan -out` as a named
  cross-provider plan surface at cloud-provisioning-guardrails.md:47-51).
- ADR-0025 / ADR-0026 (`docs/adr/0025-autonomous-cloud-provisioning-requires-a-human-approved-plan.md`,
  `docs/adr/0026-autonomous-cloud-provisioning-requires-a-human-approved-plan-gate.md`)
  — the binding gate + blast-radius classification; tool pick deliberately left
  open (ADR-0025:61-62, ADR-0026:52-53).
- ADR-0020 (`docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md`)
  — cost KPIs; ceiling calibration input.
- ADR-0005 (`docs/adr/0005-autonomous-factory-loops.md`) — the existing human
  gate for factory self-fixes touching security.
- ADR-0009 (`docs/adr/0009-fenced-steal-of-stale-file-locks.md`) — locking
  philosophy referenced for Terraform state backends.
- ADR-0023 / ADR-0024 (`docs/adr/0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md`,
  `docs/adr/0024-hosted-execution-runs-on-a-vps-docker-host-with-stock-docker-sandboxing-and-per-run-github-app-installation-tokens.md`)
  — hosted execution on Docker (the container build artifact), per-run scoped
  short-lived credentials, env-only injection.
- Repo grounding — `packages/core/src/approvals/index.ts` (`ApprovalRequest`
  `kind?: 'ship' | 'plan'` and `specPreview` at index.ts:12-25; `ApprovalGate`
  seam at index.ts:35; `createFileApprovalGate` fail-safe deny on timeout at
  index.ts:51-83, index.ts:76-81), `packages/core/src/environment/index.ts`
  (`leaseEnv`, env-only injection at index.ts:299-305),
  `packages/core/src/harness/index.ts` (`HarnessRequest.env` at index.ts:45-46),
  `packages/core/src/utils/worktree-gc.ts` (credential scrub at
  worktree-gc.ts:42,77), `packages/core/src/utils/exec.ts` (env inheritance at
  exec.ts:57,141), `packages/core/src/sandbox/index.ts` (egress at
  sandbox/index.ts:114,138), `packages/core/src/config/index.ts` (`.factory`
  state paths, costs.jsonl at index.ts:403), `packages/config/src/factory.json`
  (timeouts factory.json:11-17; `FACTORY_MERGE` opt-in at factory.json:20;
  non-empty network allowlist at factory.json:59), `packages/config/src/models.json`
  and `packages/config/src/routes.json` (config-as-source-of-truth,
  multi-provider routing), `packages/dashboard/package.json` (the concrete
  spike app candidate), ADR-0001 (`docs/adr/0001-boss-worker-checker-pipeline.md`)
  and `docs/adr/README.md` (when an ADR is written — deliberately none is added
  in this PR).
