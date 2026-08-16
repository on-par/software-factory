# AWS deployment automation for factory-built apps (Issue #625)

Date: 2026-08-14

## Purpose and scope

This is the #625 AWS discovery document: it compares realistic approaches to
automated, agent-driven AWS provisioning (raw `aws` CLI scripting vs. an IaC
layer), recommends a compute target for factory-built apps, designs IAM
credential scoping for a provisioning agent, and bounds the minimal "deploy this
app to AWS" story. It is sequenced after the **#624** deployment-automation audit
(`docs/research/deployment-automation-audit.md`, already landed) and runs **in
parallel with the Azure track**, mirroring how #620 deferred its pick and #622
later made it. It is a **discovery artifact, not a design**: it recommends a
direction **relative to today's baseline** (ad hoc CLI), makes no final
operational pick, and adds no ADR — the pick belongs to a follow-up
implementation story, exactly as #619/#620/#621 deferred theirs to #622. Every
claim about the current codebase is grounded in a `file:line` citation to this
checkout; external AWS facts are labeled approximate/volatile as of the `Date:`
line.

## The factory's real operating frame (what any approach must fit)

- **Container-native build posture.** ADR-0023
  (`docs/adr/0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md`)
  already runs the factory's hosted execution on Docker; a factory-built app is a
  TypeScript/Node service whose natural build artifact is a container. An AWS
  compute target that runs containers therefore fits the existing build shape;
  one that does not forces a packaging rewrite.
- **Long-running phases, no cold-start tolerance.** `packages/config/src/factory.json:11-17`
  sets `plan_seconds: 1800`, `build_seconds: 7200`, `check_seconds: 1800` — the
  deployed service a factory ships is expected to stay up, and the phases that
  build it run for hours. A compute target with hard lifetime caps or cold-start
  latency does not fit a general web service.
- **TypeScript-only monorepo.** The repo is ESM TypeScript throughout
  (AGENTS.md); infra defined in a language the codebase already speaks needs no
  second-language toolchain or expertise. This favors CDK/Pulumi over HCL.
- **Config-as-source-of-truth precedent.** Model routing is defined as data in the
  repo — `packages/config/src/models.json` (registry, `models.json:3`) and
  `packages/config/src/routes.json` (tier routing, `routes.json:3`) — so
  "infrastructure defined as code in the repo" is the same philosophy, not a new
  one.
- **AWS-only scope.** This story is AWS-only; there is no cross-provider
  requirement that would justify a multi-cloud tool (a Terraform argument) over
  CloudFormation-native tooling.
- **Open-by-default egress until the sandbox matures.** The sandbox inherits the
  host env (`packages/core/src/utils/exec.ts:57`, exec.ts:141 — the
  `{ ...process.env, ...opts.env }` merge) and only denies egress when the
  allowlist is empty (`packages/core/src/sandbox/index.ts:114` for sandbox-exec,
  sandbox/index.ts:138 for firejail — and the shipped default is a **non-empty**
  allowlist, `factory.json:59`). Any AWS credential an agent holds today can be
  exfiltrated over that open egress, so credential scoping is a hard requirement
  of any design, not a nicety.

## Approach A — raw `aws` CLI scripting (the throwaway baseline)

**What it is.** Imperative shell commands — `aws ecr create-repository`,
`aws ecs create-service`, `aws cloudformation deploy` — run ad hoc by an agent
with a long-lived credential. There is no record of what was provisioned beyond
what the operator remembers, no comparison of desired-vs-actual, and no
teardown.

Against the issue's framing, it fails all three of the gaps the issue opens
with:

- **No state tracking** — nothing records which resources exist, which stack they
  belong to, or who created them. A follow-up run starts from `aws` API listing,
  not from an authoritative model.
- **No drift detection** — a second run cannot tell what changed since the first;
  every run re-applies against whatever the account happens to contain.
- **No plan/diff** — changes are applied blind; there is no dry-run surface short
  of the service-specific `--dry-run` flags, which are not a general mechanism.
- **Not idempotent by construction** — `aws ecr create-repository` fails when the
  repo exists; the scripter hand-writes the idempotency (`|| true`, pre-checks)
  per command.

It is honestly the **fast-to-start baseline**: a scratch environment with one
hand-run `aws` script needs no toolchain. But it cannot satisfy a factory lane
that must plan a change, apply it, prove the result, and tear it down
repeatably. It is the thing this document's recommendation is **relative to**,
not a contender for the recommendation.

## Approach B — an IaC layer

All three candidates fix Approach A's core defect — infrastructure defined in
declarative code with a state/diff/plan surface — and differ in state ownership,
diffability, planning, and language fit. Scored against the operating frame:

### Terraform (HCL)

- **State tracking** — an explicit state file (local, or a remote backend with
  locking, e.g. S3 + DynamoDB) is the authoritative record of what was applied.
- **Diffability** — `terraform plan` computes desired-vs-state and shows pending
  changes and drift; `terraform state` introspects the recorded resources.
- **Planning** — plan/apply is the core loop; `-out` pins a plan for a gated
  apply, which is exactly the "plan then approve" pattern the factory uses.
- **Against this frame** — HCL is a new language in a TypeScript-only monorepo;
  the state backend is **our** operational burden (where does it live, who locks
  it, how does a second lane avoid stomping the first); and the tool exists to be
  multi-cloud, which this AWS-only story does not need.

### CDK (TypeScript)

- **State tracking** — infrastructure is TypeScript synthesized to
  CloudFormation templates, and **CloudFormation owns the state**: the stack
  records every resource and update, with no external state backend to manage.
- **Diffability** — `cdk diff` shows pending changes against the deployed stack.
- **Planning** — CloudFormation **change sets** are the planning mechanism; a
  change set is created and reviewed before execution, giving a real dry-run and
  rollback story.
- **For this frame** — infra in the repo's own language; the repo's
  config-as-data precedent (`models.json`, `routes.json`) extends naturally to
  infra-as-code; a TypeScript-only, AWS-only story has no cross-provider need
  that would justify Terraform. The dependency on CloudFormation's state model is
  the flip side: the tool is AWS-bound, which is fine here and constraining only
  if the factory ever goes multi-cloud.

### Pulumi (TypeScript or other languages)

- **State tracking** — state lives in Pulumi Cloud (SaaS) or a self-hosted /
  object-storage backend, similar operational burden to Terraform's but with the
  language choice as the differentiator.
- **Diffability / planning** — `pulumi preview` / `pulumi up` are the
  plan/apply surface; `pulumi stack` manages the state.
- **For this frame** — TypeScript-first like CDK, but introduces a state backend
  (Pulumi Cloud account or self-hosted) the factory must operate, plus a third-party
  control plane. It is the middle ground: the same language story as CDK with a
  weaker reason to exist in an AWS-only, no-multi-cloud world.

### The comparison at a glance

Approximate, as of the `Date:` line; external tool behavior is volatile and
re-checked before any follow-up pick.

| Approach             | State tracking                                      | Diffability               | Planning                   | Fit for this repo                                                                     |
| -------------------- | --------------------------------------------------- | ------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Raw `aws` CLI        | **None** — nothing records what was provisioned     | **None** — blind re-apply | **None** — no plan surface | Fast to start; fails state/diff/plan; the throwaway baseline                          |
| Terraform (HCL)      | Explicit state file (self-managed backend)          | `terraform plan`          | plan/apply with `-out` pin | New language (HCL) in a TS monorepo; self-hosted state; multi-cloud tool for AWS-only |
| **CDK (TypeScript)** | **CloudFormation owns state** — no external backend | `cdk diff`                | CloudFormation change sets | Repo's own language; config-as-data precedent; AWS-only scope needs no Terraform      |
| Pulumi (TS or other) | Pulumi Cloud / self-hosted backend                  | `pulumi preview`          | `pulumi preview`/`up`      | TS-first like CDK but adds a state control plane to operate                           |

## Compute-target recommendation

Evaluate ECS/Fargate, App Runner, Lambda, and EC2 for **factory-built apps** — web
services/APIs in the TS/Node monorepo, deployed as a long-running service rather
than event handlers. Grounding from the operating frame:

- **Container-native posture (ADR-0023)** — the app's build artifact is a
  container, so container-based compute targets (ECS/Fargate, App Runner) fit the
  existing build shape with no packaging rewrite.
- **Long-running phases, no cold-start tolerance** — `factory.json:11-17` phases
  run hours; a deployed web service must stay up on demand. **Lambda** has a
  15-minute per-invocation execution cap and cold-start latency — fine for event
  handlers, wrong for a general long-running web service. Rejected for this app
  class.
- **Managed vs. unmanaged** — ECS/Fargate and App Runner are AWS-managed (no EC2
  patching, no AMI lifecycle, no instance fleet to operate); **EC2** is the rawest
  option and defeats the "provisioned, diffable, teardown-able" goals by
  reintroducing the very patching/fleet ops the factory cannot babysit. Rejected.
- **Ease vs. control** — App Runner is the **simplest single-container** option
  (deploy a container, get a URL, minimal config); ECS/Fargate trades a little
  setup for first-class control (task definitions, service wiring, load
  balancing, rollouts) — both state-tracked through CloudFormation/CDK and both
  no-cold-start.

**Recommended direction to argue and justify: ECS/Fargate** — container-native,
no cold start, managed, and state-tracked through CloudFormation/CDK — **with App
Runner as the "simplest single container" alternative** and Lambda/EC2 rejected
with the reasons above. The final pick between Fargate and App Runner is deferred
to the follow-up implementation story; this document justifies the direction.

## IAM credential scoping for a provisioning agent

The agent that provisions real AWS infrastructure must be scoped the same way the
factory scopes its own per-run tokens (#621, ADR-0023): least privilege,
short-lived, per-lane/per-run, and never committed.

- **Least privilege.** A scoped IAM role and policy set for exactly the deploy
  stack's needs — ECR push, ECS service/CloudWatch update, CloudFormation
  (`cloudformation:*` on the stack) — per-resource where possible — never
  admin/root. The agent should be unable to do anything the deploy story does not
  do.
- **Short-lived credentials over long-lived access keys.** Assume a role via
  `sts:AssumeRole`, with **web-identity/OIDC federation** as the natural fit —
  the AWS equivalent of the factory's move to per-run minted short-lived GitHub
  installation tokens in #621 / ADR-0023 (`docs/research/hosted-credentials.md`).
  Long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pairs are the thing to
  avoid: they are the AWS analog of the one global PAT the per-run token design
  eliminated.
- **Per-lane/per-run scoping.** A role per lane/repo, mirroring the per-run
  installation-token design: a compromised lane reaches only its scoped role. On a
  shared host running lanes for several repos concurrently this is the security
  boundary, exactly as per-run token scoping is for GitHub (#621).
- **Never commit keys.** Consistent with the existing credential scrubber —
  `CREDENTIAL_BASENAMES` at `packages/core/src/utils/worktree-gc.ts:42`
  (`.git-credentials`, `.npmrc`) and `findCredentialFiles` at worktree-gc.ts:77 —
  and the env-only injection seam: `leaseEnv` at
  `packages/core/src/environment/index.ts:299-305` (`PORT` /
  `FACTORY_APP_PORT` / `FACTORY_BASE_URL` at index.ts:301-303) and the
  `HarnessRequest.env` mechanism (`packages/core/src/harness/index.ts:45-46`).
  AWS credentials enter a run only as process env of the single spawned run — via
  the same filtered-env seam — never written to a repo file, never baked into an
  image, never a `.env` or `.aws/credentials` file the scrubber would have to
  hunt.
- **Paired with egress reality.** Until egress enforcement lands, the sandbox
  inherits the host env (`exec.ts:57`, exec.ts:141) and egress is open by default
  (`sandbox/index.ts:114` vs. the shipped non-empty `factory.json:59`
  allowlist). Scoped, short-lived credentials are therefore a **hard requirement
  before any provisioning story**, not a follow-up hardening step — the #618/#621
  posture already established this for GitHub tokens and model keys, and AWS
  credentials with real provisioning power are the highest-value target yet.

## Minimal "deploy this app to AWS" story

Stated as future work, scoped separately — **not implemented here**:

- **One app, one region, one environment** — no multi-region, no staging/prod
  matrix in the first story.
- **A repo-owned IaC stack** — e.g. a CDK stack defining the compute target
  (Fargate service or App Runner), the image repository (ECR), a reachable
  endpoint (load balancer / service URL), and a health check.
- **A deploy cycle that fits a factory lane** — build image → push to registry →
  plan/diff (`cdk diff` / change set) → apply → verify health, plus
  `destroy`/teardown so the story is repeatable and cleanly reversible.
- **A scoped, short-lived agent role** — the IAM design above, delivered via
  env-only injection.
- **Sequencing** — after #624 (the audit this document builds on), in parallel
  with the Azure track.

## Recommendation relative to baseline

- **IaC over raw `aws` CLI.** The issue's framing — "no state tracking, no drift
  detection, no clean teardown" — is precisely what an IaC layer adds. Raw CLI
  remains the fast-to-start baseline for scratch environments, not the mechanism
  for repeatable factory deploys.
- **CDK over Terraform/Pulumi** for a TypeScript-only, AWS-only story:
  CloudFormation owns the state (no backend to operate), `cdk diff` + change sets
  give the plan/diff surface, and infra-in-TS extends the repo's
  config-as-source-of-truth philosophy (`models.json`, `routes.json`) — no HCL,
  no third-party state control plane. Terraform/Pulumi become the fallback only
  if the factory later needs multi-cloud.
- **ECS/Fargate as the compute target**, with App Runner as the simplest-single
  container alternative; Lambda and EC2 rejected for a long-running,
  no-cold-start, managed container workload.

**No final operational pick is made here.** As with #620's deferral to #622, the
final pick — Fargate vs. App Runner, the concrete stack shape, the exact role
policy — belongs to a follow-up implementation story that consumes this document
(and the Azure track's sibling document) and would be the place any ADR is
written.

## Sources

All URLs retrieved 2026-08-14. External AWS facts (limits, lifetimes, service
behavior) are **approximate as of the `Date:` line and must be re-checked before
the follow-up implementation story commits to a pick**; AWS docs are the most
volatile source here.

- AWS — Amazon ECS on AWS Fargate (serverless compute for containers, no EC2 to
  manage): https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ECS_Fargate.html
- AWS — AWS App Runner (fully managed container web apps, deploy a container to a
  reachable URL): https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html
- AWS — Lambda execution limits (15-minute per-invocation max, ephemeral
  storage, cold starts): https://docs.aws.amazon.com/lambda/latest/dg/lambda-limits.html
- AWS — Amazon EC2 (full VM control, patching/AMI lifecycle is the operator's):
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html
- AWS — CloudFormation change sets (planning mechanism, review-before-apply,
  rollback): https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html
- AWS — CDK (infrastructure in TypeScript, synthesized to CloudFormation,
  `cdk diff`): https://docs.aws.amazon.com/cdk/v2/guide/home.html
- Terraform — state (explicit state file, remote backends with locking):
  https://developer.hashicorp.com/terraform/language/state
- Pulumi — state and backends (Pulumi Cloud / self-hosted):
  https://www.pulumi.com/docs/concepts/state/
- AWS — IAM roles / `sts:AssumeRole` and short-lived credentials:
  https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html
- AWS — web identity / OIDC federation (GitHub Actions OIDC example):
  https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html
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
  and the sequencing docs `docs/research/deployment-automation-audit.md` (#624)
  and `docs/research/hosted-credentials.md` (#621) — all cited by file:line in
  the body of this document.
