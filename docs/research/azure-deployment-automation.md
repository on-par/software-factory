# Azure deployment automation for factory-built apps (Issue #626)

Date: 2026-08-14

## Purpose and scope

This is the #626 Azure discovery document: it compares realistic approaches to
automated, agent-driven Azure provisioning (raw `az` CLI scripting vs. an IaC
layer), recommends a compute target for factory-built apps, designs
service-principal credential scoping for a provisioning agent, and bounds the
minimal "deploy this app to Azure" story. It is sequenced after the **#624**
deployment-automation audit (`docs/research/deployment-automation-audit.md`,
already landed) and runs **in parallel with the #625 AWS track**
(`docs/research/aws-deployment-automation.md`, already landed), mirroring that
document's structure section for section with Azure-specific facts substituted.
It is a **discovery artifact, not a design**: it recommends a direction
**relative to today's baseline** (ad hoc `az` CLI), makes no final operational
pick, and adds no ADR — the pick belongs to a follow-up implementation story,
exactly as #620/#622 deferred theirs. Every claim about the current codebase is
grounded in a `file:line` citation to this checkout; external Azure facts are
labeled approximate/volatile as of the `Date:` line.

## The factory's real operating frame (what any approach must fit)

- **Container-native build posture.** ADR-0023
  (`docs/adr/0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md`)
  already runs the factory's hosted execution on Docker; a factory-built app is a
  TypeScript/Node service whose natural build artifact is a container. An Azure
  compute target that runs containers therefore fits the existing build shape;
  one that forces a packaging rewrite does not.
- **Long-running phases, no cold-start tolerance.** `packages/config/src/factory.json:11-17`
  sets `plan_seconds: 1800`, `build_seconds: 7200`, `check_seconds: 1800` — the
  deployed service a factory ships is expected to stay up, and the phases that
  build it run for hours. A compute target with hard lifetime caps or unavoidable
  cold-start latency on idle traffic does not fit a general web service without
  mitigation.
- **TypeScript-only monorepo.** The repo is ESM TypeScript throughout
  (AGENTS.md); infra defined in a language the codebase already speaks needs no
  second-language toolchain or expertise. This favors Pulumi (TypeScript) as the
  non-Bicep alternative and counts against HCL.
- **Config-as-source-of-truth precedent.** Model routing is defined as data in the
  repo — `packages/config/src/models.json` (registry, `models.json:3`) and
  `packages/config/src/routes.json` (tier routing, `routes.json:3`) — so
  "infrastructure defined as code in the repo" is the same philosophy, not a new
  one.
- **Azure-only scope.** This story is Azure-only; there is no cross-provider
  requirement that would justify a multi-cloud tool (a Terraform argument) over
  Azure-native tooling (Bicep). Terraform is evaluated as a candidate and named
  the fallback if the cross-provider call in #626 goes multi-cloud, but it is not
  pre-decided here.
- **Open-by-default egress until the sandbox matures.** The sandbox inherits the
  host env (`packages/core/src/utils/exec.ts:57`, exec.ts:141 — the
  `{ ...process.env, ...opts.env }` merge) and only denies egress when the
  allowlist is empty (`packages/core/src/sandbox/index.ts:114` for sandbox-exec,
  sandbox/index.ts:138 for firejail — and the shipped default is a **non-empty**
  allowlist, `factory.json:59`). Any Azure credential an agent holds today can be
  exfiltrated over that open egress, so credential scoping is a hard requirement
  of any design, not a nicety.

## Approach A — raw `az` CLI scripting (the throwaway baseline)

**What it is.** Imperative shell commands — `az group create`,
`az containerapp create`, `az webapp create`, `az aks create`,
`az deployment group create` — run ad hoc by an agent with a long-lived
credential. There is no record of what was provisioned beyond what the operator
remembers, no comparison of desired-vs-actual, and no teardown.

Against the issue's framing, it fails the same three gaps #625 documented plus
idempotency:

- **No state tracking** — nothing records which resources exist, which
  deployment they belong to, or who created them. A follow-up run starts from
  `az resource list`, not from an authoritative model.
- **No drift detection** — a second run cannot tell what changed since the first;
  every run re-applies against whatever the subscription happens to contain.
- **No plan/diff** — changes are applied blind; the service-specific
  `az deployment group create --what-if` dry-run is the exception that proves the
  rule, and it only exists once you are already driving ARM deployments, not for
  the ad hoc `az webapp` / `az aks` surface.
- **Not idempotent by construction** — `az group create` / `az containerapp
create` fail or error when the resource exists; the scripter hand-writes the
  idempotency (`|| true`, pre-checks) per command.

It is honestly the **fast-to-start baseline**: a scratch environment with one
hand-run `az` script needs no toolchain. But it cannot satisfy a factory lane
that must plan a change, apply it, prove the result, and tear it down
repeatably. It is the thing this document's recommendation is **relative to**,
not a contender for the recommendation.

## Approach B — an IaC layer

All candidates fix Approach A's core defect — infrastructure defined in
declarative code with a state/diff/plan surface — and differ in state ownership,
diffability, planning, and language fit. Scored against the operating frame:

### Bicep

- **State tracking** — Bicep transpiles to ARM templates and **Azure owns the
  state**: every deployment is recorded in the resource group's deployment
  history, so there is no external state backend to operate. This is the
  Azure-side application of the CloudFormation-owns-state argument #625 made for
  CDK.
- **Diffability** — `az deployment group what-if` (and the `--what-if` flag on
  `az deployment sub/group create`) reports pending changes against the last
  deployment and surfaces drift.
- **Planning** — the `what-if` result is the plan surface, reviewed before apply;
  deployment rollback-on-error gives a recovery story.
- **Against this frame** — Bicep is a new (but small) DSL in a TypeScript-only
  monorepo, and the tool is Azure-bound — fine for an Azure-only story,
  constraining only if the factory goes multi-cloud.

### Terraform (HCL)

- **State tracking** — an explicit state file (local, or a remote backend with
  locking, e.g. Azure Storage with lease/blob-fencing per the locking philosophy
  of ADR-0009) is the authoritative record of what was applied.
- **Diffability** — `terraform plan` computes desired-vs-state and shows pending
  changes and drift; `terraform state` introspects the recorded resources.
- **Planning** — plan/apply is the core loop; `-out` pins a plan for a gated
  apply, which is exactly the "plan then approve" pattern the factory uses.
- **Against this frame** — HCL is a new language in a TypeScript-only monorepo;
  the state backend is **our** operational burden (where does it live, who locks
  it, how does a second lane avoid stomping the first — the ADR-0009 locking
  problem restated at the infrastructure layer); and the tool exists to be
  multi-cloud, which this Azure-only story does not need.

### Pulumi (TypeScript or other languages)

- **State tracking** — state lives in Pulumi Cloud (SaaS) or a self-hosted /
  object-storage backend, similar operational burden to Terraform's but with the
  language choice as the differentiator.
- **Diffability / planning** — `pulumi preview` / `pulumi up` are the
  plan/apply surface; `pulumi stack` manages the state.
- **For this frame** — TypeScript-first, which the repo's language story favors,
  but introduces a state backend (Pulumi Cloud account or self-hosted) the
  factory must operate, plus a third-party control plane. It is the middle
  ground, exactly as it was on AWS: the same language story as the native option
  with a weaker reason to exist in an Azure-only, no-multi-cloud world.

### The comparison at a glance

Approximate, as of the `Date:` line; external tool behavior is volatile and
re-checked before any follow-up pick.

| Approach             | State tracking                                                              | Diffability                   | Planning                        | Fit for this repo                                                                       |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| Raw `az` CLI         | **None** — nothing records what was provisioned                             | **None** — blind re-apply     | **None** — no plan surface      | Fast to start; fails state/diff/plan; the throwaway baseline                            |
| **Bicep**            | **ARM deployment history owns state** — no external backend                 | `az deployment group what-if` | `what-if` reviewed before apply | Small new DSL in a TS monorepo; Azure-bound; Azure-only scope needs no multi-cloud tool |
| Terraform (HCL)      | Explicit state file (self-managed backend, e.g. Azure Storage with locking) | `terraform plan`              | plan/apply with `-out` pin      | New language (HCL) in a TS monorepo; self-hosted state; multi-cloud tool for Azure-only |
| Pulumi (TS or other) | Pulumi Cloud / self-hosted backend                                          | `pulumi preview`              | `pulumi preview`/`up`           | TS-first like Bicep but adds a third-party state control plane to operate               |

## Compute-target recommendation

Evaluate Container Apps, App Service, and AKS for **factory-built apps** — web
services/APIs in the TS/Node monorepo, deployed as a long-running service rather
than event handlers. Grounding from the operating frame:

- **Container-native posture (ADR-0023)** — the app's build artifact is a
  container, so container-based compute targets (Container Apps, App Service with
  container support) fit the existing build shape with no packaging rewrite.
- **Long-running phases, no cold-start tolerance** — `factory.json:11-17` phases
  run hours; a deployed web service must stay up on demand. Container Apps
  defaults to scale-to-zero, which means cold start on idle traffic — mitigated
  by configuring a minimum replica count (> 0) so a web service stays warm. That
  mitigation is a hard requirement under this frame, not optional tuning.
- **Managed vs. unmanaged** — Container Apps and App Service are fully
  Azure-managed (no cluster control plane, no node patching); **AKS** is managed
  Kubernetes where the control plane is Azure's but node pools, patching, and
  cluster networking remain the operator's — it reintroduces the very
  fleet/patching ops the factory cannot babysit unattended. Rejected as the
  recommendation; noted as the control-max option if a follow-up ever needs it.
- **Ease vs. control** — App Service is the **simplest single-container** option
  (deploy a container, get a URL, minimal config, always-on hosting plans that
  kill cold starts — the App Runner analog); Container Apps is the Azure-managed
  serverless container platform built on Kubernetes with no cluster ops — the
  Fargate analog — trading a little setup for container-native scaling and
  state-tracking through Bicep/ARM. Both are container-native and state-tracked.

**Recommended direction to argue and justify: Container Apps** — managed,
container-native, no cluster ops, and state-tracked through Bicep/ARM, with cold
start mitigated by min-replicas — **with App Service as the "simplest single
container" alternative** and AKS rejected with the reasons above. The final pick
between Container Apps and App Service is deferred to the follow-up
implementation story; this document justifies the direction.

## Service-principal credential scoping for a provisioning agent

The agent that provisions real Azure infrastructure must be scoped the same way
the factory scopes its own per-run tokens (#621, ADR-0023): least privilege,
short-lived, per-lane/per-run, and never committed.

- **Least privilege.** A service principal (app registration) with RBAC role
  assignments scoped to the deploy resource group only — e.g. `Contributor` on
  that resource group, never subscription-scope `Contributor`/`Owner`; `AcrPush`
  on the registry; scoped roles per resource type where Azure's built-ins allow.
  The agent should be unable to do anything the deploy story does not do.
- **Short-lived credentials over long-lived client secrets.** Use workload
  identity federation — app-registration federated credentials exchanged for
  OIDC tokens (`az login --federated-token`) — the Azure analog of #625's
  `sts:AssumeRole` + web-identity/OIDC and of the factory's own move to per-run
  minted short-lived GitHub installation tokens (#621 / ADR-0023,
  `docs/research/hosted-credentials.md`). Long-lived service-principal client
  secrets / passwords are the thing to avoid: they are the Azure analog of the
  one global PAT and of long-lived AWS access keys.
- **Per-lane/per-run scoping.** A service principal / app registration per
  lane/repo, mirroring the per-run installation-token design: a compromised lane
  reaches only its scoped role. On a shared host running lanes for several repos
  concurrently this is the security boundary, exactly as per-run token scoping is
  for GitHub (#621).
- **Never commit keys.** Consistent with the existing credential scrubber —
  `CREDENTIAL_BASENAMES` at `packages/core/src/utils/worktree-gc.ts:42`
  (`.git-credentials`, `.npmrc`) and `findCredentialFiles` at worktree-gc.ts:77 —
  and the env-only injection seam: `leaseEnv` at
  `packages/core/src/environment/index.ts:299-305` (`PORT` /
  `FACTORY_APP_PORT` / `FACTORY_BASE_URL` at index.ts:301-303) and the
  `HarnessRequest.env` mechanism (`packages/core/src/harness/index.ts:45-46`).
  Azure credentials enter a run only as process env of the single spawned run —
  via the same filtered-env seam — never written to a repo file, never baked
  into an image, never a `.env` or a persisted `az` CLI profile the scrubber
  would have to hunt.
- **Paired with egress reality.** Until egress enforcement lands, the sandbox
  inherits the host env (`exec.ts:57`, exec.ts:141) and egress is open by default
  (`sandbox/index.ts:114` vs. the shipped non-empty `factory.json:59`
  allowlist). Scoped, short-lived service-principal credentials are therefore a
  **hard requirement before any provisioning story**, not a follow-up hardening
  step — the #618/#621 posture already established this for GitHub tokens and
  model keys, and Azure credentials with real provisioning power are the
  highest-value target yet.

## Minimal "deploy this app to Azure" story

Stated as future work, scoped separately — **not implemented here**:

- **One app, one region, one environment** — e.g. `eastus`; no multi-region, no
  staging/prod matrix in the first story.
- **A repo-owned Bicep stack** — defining the compute target (a Container Apps
  environment + app, or an App Service plan), the container registry (ACR), a
  reachable endpoint, and a health check.
- **A deploy cycle that fits a factory lane** — build image → push to ACR →
  plan/diff (`az deployment group what-if`) → apply → verify health, plus
  teardown (delete the resource group) so the story is repeatable and cleanly
  reversible.
- **A scoped, short-lived agent service principal** — the credential design
  above, delivered via env-only injection.
- **Sequencing** — after #624 (the audit this document builds on), in parallel
  with #625 (the AWS track), feeding the #626 cross-provider decision.

## Recommendation relative to baseline

- **IaC over raw `az` CLI.** The issue's framing — "no state tracking, no drift
  detection, no clean teardown" — is precisely what an IaC layer adds. Raw CLI
  remains the fast-to-start baseline for scratch environments, not the mechanism
  for repeatable factory deploys. This **converges with the AWS answer**.
- **Bicep over Terraform** for an Azure-only story: Azure owns the state (ARM
  deployment history — no backend to operate), `az deployment group what-if`
  gives the plan/diff surface, and infra-as-code extends the repo's
  config-as-source-of-truth philosophy (`models.json`, `routes.json`). Pulumi is
  the TypeScript-first alternative worth noting given the TS-only monorepo.
  Terraform becomes the fallback only if the factory later needs multi-cloud.
- **Container Apps as the compute direction**, with App Service as the simplest-
  single-container alternative; AKS rejected for ops burden.

**No final operational pick is made here.** As with #625's deferral to its
follow-up, the final pick — Container Apps vs. App Service, the concrete stack
shape, the exact RBAC role — belongs to a follow-up implementation story that
consumes this document (and the #625 AWS document's sibling findings) and would
be the place any ADR is written.

## Where Azure converges with and diverges from AWS (feeding #626)

This section is the explicit cross-provider comparison the #625 document could
not write; it feeds the cross-provider decision tracked in #626.

**Converges with AWS:**

- **"IaC over raw CLI either way"** — both providers reject ad hoc CLI as the
  repeatable mechanism; raw `az` and raw `aws` both fail state tracking, drift
  detection, planning, and teardown, and both stay useful only as the fast
  baseline.
- **Short-lived federated/OIDC credentials over long-lived keys/secrets** —
  Azure workload identity federation (`az login --federated-token`) is the same
  shape as AWS `sts:AssumeRole` + web-identity/OIDC, and both match the factory's
  per-run minted short-lived GitHub installation tokens (#621 / ADR-0023).
- **Managed-container compute direction** — Container Apps ≈ ECS/Fargate;
  App Service ≈ App Runner; both sides land on a managed, container-native
  compute target with a "simplest single container" alternative.
- **Plan/diff/state-tracking are table stakes** on both providers, and
  per-lane/per-run credential scoping and never-commit apply identically.

**Diverges from AWS:**

- **IaC tooling and state ownership** — Bicep/ARM with Azure-owned deployment
  history vs. CDK/CloudFormation with AWS-owned stack state. Only Terraform/
  Pulumi span both providers, and each costs the provider-native state/plan
  surface to do so.
- **Compute-target shapes** — App Service has no direct AWS analog, and App
  Runner / ECS-Fargate have no exact Azure twins (Container Apps is the closest
  to Fargate); scale-to-zero with a min-replicas mitigation is an Azure-native
  twist with no AWS Fargate equivalent.
- **Identity model** — Azure service principals + RBAC role assignments
  (resource-scoped role assignment) vs. AWS IAM roles + policies (policy/trust
  attachment); workload identity federation on the Azure side vs. OIDC web
  identity on the AWS side.
- **Control planes** — `az`/ARM/Bicep vs. `aws`/CloudFormation/CDK.

**Implication for #626:** a single cross-provider tool (Terraform or Pulumi)
buys one control plane and one state model across both providers at the cost of
abandoning both providers' native tooling; provider-native both ways (Bicep +
CDK) means two tools, two state models, and two identity models, each simplest
in its own provider. This document presents both sides and the trade-off; it
does not make the call.

## Sources

All URLs retrieved 2026-08-14. External Azure facts (limits, lifetimes, service
behavior) are **approximate as of the `Date:` line and must be re-checked before
the follow-up implementation story commits to a pick**; Azure docs are the most
volatile source here.

- Azure — Azure Container Apps (serverless container platform built on
  Kubernetes, no cluster control plane or node patching to operate):
  https://learn.microsoft.com/en-us/azure/container-apps/overview
- Azure — App Service / Web App for Containers (PaaS, always-on hosting plans,
  deploy a container to a reachable URL):
  https://learn.microsoft.com/en-us/azure/app-service/overview
- Azure — AKS (managed Kubernetes; the operator still owns node pools, patching,
  and cluster networking):
  https://learn.microsoft.com/en-us/azure/aks/what-is-aks
- Azure — Bicep (infrastructure-as-code DSL transpiled to ARM templates):
  https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/overview
- Azure — ARM `what-if` deployment dry-run (planning surface for pending changes
  and drift):
  https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-what-if
- Azure — workload identity federation / OIDC for service principals
  (`az login --federated-token`):
  https://learn.microsoft.com/en-us/entra/identity/workload-id/workload-identity-federation
- Azure — RBAC role assignments (least-privilege, resource-group-scoped roles):
  https://learn.microsoft.com/en-us/azure/role-based-access-control/overview
- Terraform — state (explicit state file, remote backends with locking, e.g.
  Azure Storage):
  https://developer.hashicorp.com/terraform/language/state
- Pulumi — state and backends (Pulumi Cloud / self-hosted):
  https://www.pulumi.com/docs/concepts/state/
- Repo grounding — `packages/config/src/factory.json` (timeouts factory.json:11-17,
  sandbox/network allowlist factory.json:59), `packages/config/src/models.json`
  and `packages/config/src/routes.json` (config-as-source-of-truth),
  `packages/core/src/utils/exec.ts` (env inheritance exec.ts:57,141),
  `packages/core/src/sandbox/index.ts` (egress sandbox/index.ts:114,138),
  `packages/core/src/utils/worktree-gc.ts` (credential scrub worktree-gc.ts:42,77),
  `packages/core/src/environment/index.ts` (leaseEnv, env-only injection
  index.ts:299-305), `packages/core/src/harness/index.ts` (HarnessRequest.env
  harness/index.ts:45-46), ADR-0023
  (`docs/adr/0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md`),
  ADR-0009 (`docs/adr/0009-fenced-steal-of-stale-file-locks.md`, locking
  philosophy referenced for Terraform state backends), and the sequencing docs
  `docs/research/deployment-automation-audit.md` (#624) and
  `docs/research/aws-deployment-automation.md` (#625 — AWS-specific findings are
  referenced here, not duplicated) — all cited by file:line in the body of this
  document.
