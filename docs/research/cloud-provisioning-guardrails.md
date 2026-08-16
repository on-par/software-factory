# Cloud provisioning guardrails for the autonomous factory (Issue #627)

Date: 2026-08-14

## Purpose and scope

This is the #627 guardrails **design** document: the specification the follow-up
provisioning implementation builds against. It is the direct follow-up to the
landed #624 audit (`docs/research/deployment-automation-audit.md`), the #625 AWS
research (`docs/research/aws-deployment-automation.md`), and the #626 Azure
research (`docs/research/azure-deployment-automation.md`) — those three are its
inputs, and their action catalog is what this document classifies. It specifies
three guardrails the issue demands: (1) cost ceilings per provisioning action
**and how they would actually be enforced, not merely documented**, (2) a
**mandatory plan-then-approve gate** before any action that creates billable or
internet-facing infrastructure, and (3) a **blast-radius classification** that
mechanically divides provisioning actions into those that may run fully
autonomously and those that always require human approval.

It is a **design artifact, not a discovery artifact**: unlike #624/#625/#626,
which made recommendations relative to a baseline and explicitly deferred every
pick, this document's plan-then-approve gate and blast-radius classification are
decisions that constrain how the future provisioning implementation must be
written and would be expensive to reverse, so they are recorded once as an
Accepted ADR in the same PR (ADR-0025, `docs/adr/0025-autonomous-cloud-provisioning-requires-a-human-approved-plan.md`).
This document implements nothing: no code, no config file, no SCP/Azure Policy
template changes. It deliberately does **not** make the deferred #625/#626 final
tool pick (CDK vs. Bicep vs. Terraform; Fargate vs. App Runner; Container Apps
vs. App Service) — the guardrails are tool-independent and hold whichever pick
lands.

External cloud facts (budget cost-action behavior, service-control-policy /
Azure Policy semantics) are labeled **approximate/volatile** as of the `Date:`
line and must be re-verified before the follow-up implementation commits to a
mechanism; every claim about this checkout is grounded in a `file:line`
citation.

## The operating frame the guardrails must fit

The three landed documents establish the frame the guardrails must fit without
breaking:

- **IaC over raw CLI, with a plan/diff surface.** #625 and #626 both reject ad
  hoc CLI scripting (raw `aws` / raw `az`) as the repeatable mechanism because
  it has no state tracking, no drift detection, no plan/diff, and no teardown
  (`aws-deployment-automation.md`, Approach A; `azure-deployment-automation.md`,
  Approach A), and both land on an IaC layer whose plan surface is the
  review-before-apply seam: `cdk diff` / CloudFormation change sets on AWS,
  `az deployment group what-if` on Azure, and `terraform plan -out` as the
  cross-provider fallback (`aws-deployment-automation.md:102-116`,
  `azure-deployment-automation.md:96-110`). The plan surface is precisely what
  the plan-then-approve gate below reuses.
- **Scoped, short-lived, never-committed credentials.** Both documents require
  a per-lane/per-run federated credential (AWS `sts:AssumeRole` +
  web-identity/OIDC; Azure workload identity federation), injected only as
  process env of the single spawned run — the same posture the factory already
  applies to GitHub tokens and model keys via `leaseEnv` at
  `packages/core/src/environment/index.ts:299-305` (`PORT` /
  `FACTORY_APP_PORT` / `FACTORY_BASE_URL` at index.ts:301-303) and the
  `HarnessRequest.env` seam (`packages/core/src/harness/index.ts:45-46`),
  consistent with the credential scrubber (`CREDENTIAL_BASENAMES` at
  `packages/core/src/utils/worktree-gc.ts:42`, `findCredentialFiles` at
  worktree-gc.ts:77).
- **Open-by-default egress until the sandbox matures.** The sandbox inherits
  the host env (`packages/core/src/utils/exec.ts:57`, exec.ts:141 — the
  `{ ...process.env, ...opts.env }` merge) and only denies egress when the
  allowlist is empty (`packages/core/src/sandbox/index.ts:114` for sandbox-exec,
  sandbox/index.ts:138 for firejail — and the shipped default is a non-empty
  allowlist, `packages/config/src/factory.json:59`). Any provisioning
  credential an agent holds can today be exfiltrated over that open egress, so
  credential scoping and the fail-closed policy rung below are hard
  prerequisites of any autonomous provisioning, exactly as #625 and #626 each
  concluded (`aws-deployment-automation.md:172-211`,
  `azure-deployment-automation.md:186-228`).
- **The minimal deploy stories actually on the table.** The actions this
  document classifies are the ones the two minimal stories enumerate: on AWS,
  build image → push to ECR → plan/diff (`cdk diff` / change set) → apply →
  verify health, plus destroy/teardown (`aws-deployment-automation.md:213-228`);
  on Azure, build image → push to ACR → plan/diff (`az deployment group what-if`)
  → apply → verify health, plus teardown by deleting the resource group
  (`azure-deployment-automation.md:230-246`). The per-action catalog below is
  derived from these two stories.
- **Cost is already a measured KPI.** The factory tracks per-merge cost as a
  first-class KPI (ADR-0020) via `.factory/costs.jsonl`, resolved as part of the
  `.factory` state paths in `packages/core/src/config/index.ts:388-413`
  (costs.jsonl at index.ts:403), with per-model price fields in
  `packages/config/src/models.json` (`deployment-automation-audit.md:280-286`).
  This machinery is the calibration input for the ceiling values below.

## Cost ceilings per provisioning action

Define a **ceiling** as a per-action, per-stack monthly-cost cap in concrete
units (USD/month), set per deployment class (preview vs. persistent), and
declared in config — the config-as-source-of-truth precedent of
`packages/config/src/models.json` (registry, models.json:3) and
`packages/config/src/routes.json` (tier routing, routes.json:3), not a constant
buried in core. The action catalog from the two minimal stories, each with its
own ceiling:

| Action                   | AWS shape (#625)             | Azure shape (#626)                    | Ceiling dimension                            |
| ------------------------ | ---------------------------- | ------------------------------------- | -------------------------------------------- |
| Registry repo create     | `aws ecr create-repository`  | `az acr create`                       | storage, near-free; ceiling ~ $0             |
| Compute service create   | Fargate service / App Runner | Container Apps app / App Service plan | instance class/size × replica count × uptime |
| Endpoint / load balancer | ALB / service URL            | ingress / public endpoint             | data transfer, per-hour LB charge            |
| State                    | CloudFormation stack         | ARM deployment history                | none (managed, no direct cost)               |
| Health check             | target group / CW alarms     | app probe / alerts                    | negligible; cap alert volume                 |
| Teardown                 | `cdk destroy` / stack delete | delete resource group                 | negative cost (releases spend)               |

### How the ceilings are actually enforced, not merely documented

A ceiling that is only documented is not enforced, and the acceptance criterion
for this issue is explicitly that the enforcement mechanism be described, not
just the number. The ladder below is ordered from the moment of the action to
the asynchronous backstop; the primary rung happens **at plan time, before any
apply**.

**Rung 1 — plan-time refusal (primary).** A tool-independent resource-shape
cost estimate is computed from the plan/diff that the plan-then-approve gate
already requires (#625/#626's plan surface), before apply: instance
class/size, replica count, region, storage, and expected uptime are read off the
plan/diff and multiplied against config-declared unit prices; the estimate is
compared against the action's config-declared ceiling, and apply is **refused**
when the estimate exceeds the ceiling. This rung costs nothing extra to compute
because it consumes the plan the gate already produces, and it deliberately
avoids depending on volatile third-party cost-estimator tools (whose exact
capabilities differ per provider and would make the mechanism provider-specific
before the #625/#626 pick is made) — those tools are the refinement once the
follow-up pick lands, not the prerequisite. This is the rung that makes the
ceiling a real gate: the apply step cannot run on an over-ceiling plan because
the gate never approves it.

**Rung 2 — cloud-native budget cost-action (backstop).** AWS Budgets with a
cost action and Azure budgets with an action group terminate or stop spend
**asynchronously** when actual spend breaches the budget (AWS — approximate as
of the `Date:` line:
https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-actions.html;
Azure — budget threshold firing an action group, approximate as of the `Date:`
line: https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/cost-management-budget-scenario).
State honestly: budgets act **after the fact** and are **coarse** (they fire on
measured spend, minutes to hours after the action, and stop or warn at the
subscription/scope level, not the per-action level). That is exactly why they
are the backstop and not the primary gate — a ceiling enforced "only by a
budget" is a ceiling that is documented but not enforced at the moment of the
action.

**Rung 3 — fail-closed provider policy (belt and suspenders).** SCPs on AWS and
Azure Policy deny-lists on Azure deny oversized or over-permissive resource
shapes and public exposure **by default**, regardless of which credential makes
the call (AWS — SCPs bound the maximum permissions of member-account IAM users
and roles, approximate/volatile as of the `Date:` line:
https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html;
Azure — Policy `Deny` effects block non-compliant creates and updates at
resource-create time, approximate/volatile as of the `Date:` line:
https://learn.microsoft.com/en-us/azure/governance/policy/overview). This rung
is what makes the ceiling hold when the plan-time estimate is wrong or when a
lane's credentials are hijacked: even a validly-approved action cannot exceed
the deny-listed shape because the provider refuses the call. Because egress is
open by default until the sandbox matures (`exec.ts:57`, exec.ts:141;
`factory.json:59`), this rung is a hard prerequisite, not a nicety — it is the
provider-side version of the #625/#626 credential-scoping conclusion.

**Rung 4 — ADR-0020 cost-KPI calibration.** Ceiling defaults are not chosen
arbitrarily; they are calibrated from what the factory actually measures
deploying (ADR-0020, `.factory/costs.jsonl` at
`packages/core/src/config/index.ts:403`; per-model prices in
`packages/config/src/models.json`). The measured per-merge cost of the app
being provisioned sets the order of magnitude for its provisioning ceiling; a
ceiling set far above measured reality is a ceiling that never bites, and one
set below it blocks the provisioning story the #625/#626 docs set up. The
measurement machinery exists (`deployment-automation-audit.md:280-286`); the
follow-up story turns its numbers into ceiling defaults.

## The mandatory plan-then-approve gate

For **any** action that creates billable or internet-facing infrastructure, the
pipeline order is **PLAN → APPROVE → APPLY**, mirroring the Terraform/CDK
plan/apply split the #625/#626 documents established: `terraform plan -out`
pins a plan for a gated apply, `cdk diff` / CloudFormation change sets and
`az deployment group what-if` are the review-before-apply surfaces
(`aws-deployment-automation.md:102-116`, `azure-deployment-automation.md:96-110`).
The gate is **structural, not advisory**: an apply step cannot run without an
approved plan.

**Enforcement mechanism — reuse the existing `ApprovalGate` seam.** The factory
already owns the enforcement machinery. `packages/core/src/approvals/index.ts`
defines `ApprovalRequest` with `kind?: 'ship' | 'plan'` and a `specPreview` for
plan approvals (index.ts:20-23), the `ApprovalGate` seam
(`packages/core/src/approvals/index.ts:35`), a file transport that writes
`<id>.request.json` and awaits `<id>.response.json` (`createFileApprovalGate`,
index.ts:51-83), and — critically — the gate already **fails closed on
timeout**: after `timeoutMs` without a response it returns
`{ approved: false }` (index.ts:76-81). The provisioning gate extends this
seam with a new `provision` approval kind whose payload carries the plan/diff
summary and the plan-time cost estimate from Rung 1; the apply step may run
only after a `{ approved: true }` response, and a lane that never gets one
denies by default. This is the same fail-safe-deny posture the existing seam
already guarantees, applied to a `provision` kind.

**No blind applies in the autonomous path.** A plan must exist and be reviewed
before any apply. The #625 Approach A critique is the thing the gate
eliminates: raw CLI "changes are applied blind; there is no dry-run surface"
(`aws-deployment-automation.md:71-72`); #626 makes the same point for `az`
(`azure-deployment-automation.md:76-79`). A lane that cannot produce a plan
cannot apply — which is one more reason the follow-up pick must be an IaC layer
with a plan surface, not raw CLI.

**Grounding in the org precedent (#624).** This is not a new idea for on-par
pipelines; it is the pattern the audit already documented, applied to
provisioning. App Store Connect app-record creation and app-specific-password
generation stayed human-gated even in otherwise automated flows
(`deployment-automation-audit.md`, playlift human-gated steps and sound-buddy
human-gated steps); sound-buddy's release is draft-then-promote plus a
confirmation prompt before any publish (`deployment-automation-audit.md`,
sound-buddy Patterns observed); and ADR-0005 already holds that any factory
self-fix touching security is human-gated (`docs/adr/0005-autonomous-factory-loops.md`,
Consequences). Provisioning actions are the cloud version of those gates.

## Blast-radius classification

A **mechanical decision procedure** over the #625/#626 action catalog, with the
deciding axes made explicit so a checker can verify the classification and the
future implementation can apply it without judgment calls. The axes:

1. **Billability / persistence** — does the action create ongoing spend that
   outlives the run?
2. **Internet exposure** — does the action create an endpoint reachable from
   the public internet?
3. **Production vs. throwaway** — is this the product's production
   infrastructure or a disposable preview?
4. **TTL guarantee** — is there an enforced, automatic N-hour teardown?
5. **IAM/credential mutation** — does the action create, modify, or assume
   roles/policies/secrets?

**Class A — may be fully autonomous.** An action is Class A **only if all** of
the following hold: (a) it comes from a plan (never a blind apply — the gate
above still applies, autonomy is about the approval step), (b) it is a throwaway
preview environment with an enforced N-hour teardown (the destroy/teardown step
#625/#626 already require: `aws-deployment-automation.md:222-224`,
`azure-deployment-automation.md:239-242`), (c) its endpoint is non-production,
(d) its plan-time cost estimate is under the autonomous ceiling, and (e) it
mutates no IAM/credential/role. Autonomy means **no per-action human approval** —
it never means **no plan**.

**Class B — always human-approved.** Production infrastructure; anything with
persistent cost; internet-facing resources that are not approved ephemeral
previews; any IAM/credential/role change; any action outside the pre-approved
stack shape; any cross-environment action. One of these axes being true puts
the action in Class B.

**Decision procedure over the action catalog** (axes: persist = persistent
cost; exposure = internet-facing; prod = production infra; TTL = enforced
teardown; IAM = credential mutation):

| Action                                                                  | Persist    | Exposure | Prod    | TTL          | IAM     | Class                                                                                      |
| ----------------------------------------------------------------------- | ---------- | -------- | ------- | ------------ | ------- | ------------------------------------------------------------------------------------------ |
| Registry repo create (ECR/ACR)                                          | ~no        | no       | varies  | n/a          | no      | A (repo is throwaway-scoped); B if shared/prod                                             |
| Compute service create (Fargate/App Runner, Container Apps/App Service) | yes        | yes      | if prod | preview: yes | no      | **A** if all of (preview, non-prod endpoint, TTL-enforced, under ceiling); **B** otherwise |
| Endpoint / load balancer (ALB / public ingress)                         | yes        | yes      | if prod | preview: yes | no      | **A** if the preview-service it fronts is Class A; **B** otherwise                         |
| State (CloudFormation stack / ARM deployment)                           | no         | no       | n/a     | n/a          | no      | A                                                                                          |
| Health check (CW alarms / probes / alerts)                              | negligible | no       | n/a     | n/a          | no      | A                                                                                          |
| Teardown / destroy (stack delete / resource-group delete)               | reduces    | no       | n/a     | n/a          | no      | A                                                                                          |
| IAM / role / service-principal / secret mutation                        | n/a        | n/a      | n/a     | n/a          | **yes** | **B always**                                                                               |

The classification is exactly why #627 is sequenced after #625/#626: the
decision procedure needs a concrete action catalog to classify, and those two
documents are the ones that put the catalog on the table
(`aws-deployment-automation.md:213-228`, `azure-deployment-automation.md:230-246`).
The most expensive autonomous mistake the classification permits is a
TTL-capped, under-ceiling, non-production preview environment — which is the
intended bound on blast radius.

## Sequencing and where the ADR binds

- **The #625/#626 pick is still deferred, and this document does not make it
  either.** Both research documents explicitly defer their final operational
  pick to a follow-up implementation story
  (`aws-deployment-automation.md:246-250`, `azure-deployment-automation.md:263-267`),
  and this document's guardrails are tool-independent: the gate and the
  classification hold whether the follow-up picks CDK, Bicep, or Terraform.
  That is why the ADR is written now — ADR-0025 records the gate and the
  blast-radius classification as binding on the follow-up implementation while
  deliberately leaving the tool pick open.
- **Opt-in philosophy.** The factory's autonomous merge is already an explicit
  opt-in — `FACTORY_MERGE=1` enables autonomous squash-merge and it is off by
  default (`README.md` safety note; `packages/config/src/factory.json:20`).
  Provisioning autonomy should follow the same philosophy **or stricter**: the
  ADR's default is human-approved, so an operator who wants Class A preview
  autonomy must explicitly enable it per product/constitution; nothing that
  creates billable or internet-facing infrastructure is autonomous by default.
- **What this PR ships is the design.** The deliverables are this document, the
  Accepted ADR-0025, and the ADR index row — the enforcement machinery (the
  `provision` approval kind, the plan-time cost check, the SCP/Azure Policy
  templates) is the follow-up implementation story's work, written against the
  contract ADR-0025 records.

## Sources

All URLs retrieved on the `Date:` line; external AWS/Azure facts (budget
cost-action behavior, SCP / Azure Policy semantics) are **approximate and
volatile** and must be re-verified before the follow-up implementation commits
to a mechanism.

- AWS — Budgets cost actions (terminate/stop spend asynchronously on budget
  breach): https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-actions.html
- AWS — Service control policies (bound the maximum permissions of member-account
  IAM users and roles): https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html
- Azure — budget action groups (budget threshold firing an Azure Monitor action
  group): https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/cost-management-budget-scenario
- Azure — Azure Policy overview (`Deny` effects block non-compliant creates and
  updates): https://learn.microsoft.com/en-us/azure/governance/policy/overview
- #624 — `docs/research/deployment-automation-audit.md` (human-gated-step
  precedent: playlift / sound-buddy; cost-KPI machinery).
- #625 — `docs/research/aws-deployment-automation.md` (IaC vs. raw `aws` CLI;
  `cdk diff` / change sets; credential scoping; minimal deploy story).
- #626 — `docs/research/azure-deployment-automation.md` (IaC vs. raw `az` CLI;
  `az deployment group what-if`; service-principal scoping; minimal deploy
  story).
- Repo grounding — `packages/core/src/approvals/index.ts` (`ApprovalRequest`
  `kind?: 'ship' | 'plan'` and `specPreview` at index.ts:20-23; `ApprovalGate`
  seam at index.ts:35; `createFileApprovalGate` fail-safe deny on timeout at
  index.ts:51-83), `packages/core/src/config/index.ts` (`.factory` state paths
  and `costs.jsonl` at index.ts:388-413), `packages/core/src/environment/index.ts`
  (`leaseEnv`, env-only injection at index.ts:299-305),
  `packages/core/src/harness/index.ts` (`HarnessRequest.env` at index.ts:45-46),
  `packages/core/src/utils/worktree-gc.ts` (credential scrub at worktree-gc.ts:42,77),
  `packages/core/src/utils/exec.ts` (env inheritance at exec.ts:57,141),
  `packages/core/src/sandbox/index.ts` (egress at sandbox/index.ts:114,138),
  `packages/config/src/factory.json` (non-empty network allowlist at
  factory.json:59; `FACTORY_MERGE=1` opt-in note at factory.json:20),
  `packages/config/src/models.json` and `packages/config/src/routes.json`
  (config-as-source-of-truth), ADR-0020
  (`docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md`,
  cost KPIs), ADR-0023 / ADR-0024 (hosted execution, scoped short-lived
  credentials), and ADR-0005 (`docs/adr/0005-autonomous-factory-loops.md`,
  human gate for security-touching fixes).
