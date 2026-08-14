# Hosted sandboxed execution recommendation (Issue #622)

Date: 2026-08-14

## Purpose and scope

This is the **#622 decision document** for the hosted-execution series: it makes
the three picks the discovery docs deliberately deferred, so the factory can
actually be hosted. #619 (`docs/research/sandbox-tech-comparison.md`) short-listed
plain Docker + seccomp/AppArmor as the near-term baseline and Firecracker microVMs
as the strong-isolation target and explicitly said "the final pick is tracked
separately in #622". #620 (`docs/research/hosting-comparison.md`) left VPS + Docker
as the baseline with Cloudflare Containers as the serious near-miss, again without
a final pick. #621 (`docs/research/hosted-credentials.md`) designed per-run minted
GitHub tokens and model-key injection and deferred the operational pick. #618
(`docs/research/sandbox-posture-audit.md`) established the v1 envelope these picks
replace. Unlike those documents — which are "discovery artifacts, not a design" —
this one **is the decision**: it picks one sandbox tech, one hosting model, and one
credential approach, weighs each against the factory's four real requirements,
records the picks in ADR-0023 (`docs/adr/0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md`),
and ends with the smallest go/no-go spike that proves the combination — stated as
**future work, scoped separately**, exactly as the issue requires. No code, no
migration plan, and no spike implementation are in scope here.

Sequencing: this issue depends on #618, #619, #620, and #621 — all landed — and
ships last in the series, resolving the deferrals they each made to #622.

## The factory's requirements the pick must fit

Every pick below is scored against the factory's real operating frame, grounded in
this checkout:

- **Long-running** — `packages/config/src/factory.json:11-17` sets
  `plan_seconds: 1800`, `build_seconds: 7200`, `check_seconds: 1800`. CHECK alone
  ran ~33 minutes (from the issue), and a full plan → build → check → ship cycle
  with rework exceeds an hour. A host must sustain a single phase for up to 2
  hours and a whole cycle for well over an hour **without a wall-clock or CPU cap**.
- **Real git/npm/subprocess access** — `shipIssue` (`packages/cli/src/cli/index.ts:874`)
  sets up a per-issue git worktree through `gitFetch`/`setupWorktree` subprocesses
  (index.ts:958-973), then drives the four phase entry points: `planPhase`
  (`packages/core/src/phases/plan.ts:149`, invoked at index.ts:1093-1114),
  `buildPhase` (`packages/core/src/phases/build.ts:22`, invoked at index.ts:1146),
  `checkPhase` (`packages/core/src/phases/check.ts:127`, invoked at index.ts:1189),
  and `shipPhase` (`packages/core/src/phases/ship.ts:33`, invoked at index.ts:1260).
  Each shells out to model CLIs (claude/codex/ollama via the harnesses), runs
  `npm ci`, the checker framework (compile/tests/lint/links/accessibility,
  `packages/core/src/checkers/`), playwright, and `git push`. No serverless
  function runtime offers a real subprocess model; the host must be a full OS.
- **Occasional Docker-in-Docker** — some repos' tests build containers (integration
  tests that spin up their own services), so the sandbox needs a nested-Docker
  story for those runs.
- **Real GitHub write access** — `getOctokit()` reads one global
  `GITHUB_TOKEN`/`GH_TOKEN` (index.ts:204) with a `gh auth token` fallback
  (index.ts:205-209) and threads that one octokit into every phase (index.ts:894);
  `git push` rides the worktree's inherited credential helper
  (`packages/core/src/phases/ship.ts:93`, ship.ts:132); `gh pr merge --admin`
  (index.ts:2388) is gated by a host-wide `FACTORY_MERGE_ADMIN === '1'` env flag
  (index.ts:2544).

## Pick 1 — sandbox tech: plain Docker + seccomp/AppArmor

**Chosen** from #619's near-term short-list entry: stock Docker with the default
seccomp profile, the auto-loaded `docker-default` AppArmor profile, a non-root
user, and no `--privileged`.

- **Fastest cold start in the fresh-worktree-per-run frame.** ADR-0001
  (`docs/adr/0001-boss-worker-checker-pipeline.md`) runs each phase in an isolated
  per-issue worktree (`worktree.prefix: "ship-it/"`, `worktree.parent: "../"`,
  `factory.json:22-28`), so the boundary is stood up per run and its cost
  multiplies across PLAN/BUILD/CHECK and every rework round. Plain Docker's
  boundary is sub-second to a few seconds on a warm image (per #619) — effectively
  free where Firecracker's image-readiness cold-start repeats every boundary.
- **Zero marginal cost on the VPS host.** The host already runs Docker (Pick 2); a
  sandbox is just another container. No per-run-hour bill, no image-cache or
  VM-lifecycle ops.
- **The only fully native Docker-in-Docker story** of the short-list. Repos whose
  tests need nested Docker get a socket mount or a nested `dockerd` — standard
  setups — where gVisor needs flag surgery and Firecracker needs a full guest
  install. (#619's caveat stands: socket-mounting weakens the boundary, so the
  spike should prefer a nested `dockerd` for DinD repos.)
- **It replaces the v1 process-level envelope** the #618 audit dissected:
  `sandbox-exec`/`firejail` OS-process restrictions
  (`packages/core/src/sandbox/index.ts:33-40`, index.ts:125-140) with a real
  kernel-boundary + policy surface. Grounded in #618, not re-derived: egress is
  open-by-default because a non-empty allowlist is never enforced without a proxy
  (sandbox/index.ts:114 only emits `(deny network-outbound)` when the allowlist is
  empty; the shipped default is non-empty, `factory.json:59`); PLAN runs unwrapped
  (cli/index.ts:1093-1113, no sandbox option — unlike build at index.ts:1160 and
  check at index.ts:1200); and the enforcement signal is noise, not evidence
  (index.ts:143; all 14 recorded `sandbox_violation` events are Codex PATH-alias
  warnings). The Docker pick must therefore also cover **all four phases** once
  hosted, not just build/check — the #622 scope the issue names.

**Rejected — Firecracker microVMs** (E2B managed or self-hosted). Strongest
isolation: hardware-virtualized per-run kernel, the architecture the reference
products use. But in the fresh-worktree-per-run frame its image-readiness
cold-start repeats on every PLAN/BUILD/CHECK/rework boundary, and self-hosted
Firecracker adds KVM-host + image-cache + VM-lifecycle ops the near term does not
need. It is kept as the **strong-isolation escalation target**, not the pick.
**Rejected — gVisor-wrapped Docker**: lands between the two on isolation and has
the weakest DinD story of the three (per #619). WebContainers was already ruled
out by #619.

## Pick 2 — hosting model: VPS + Docker baseline

**Chosen** — the #620 baseline. A plain virtual server running Docker, provisioned
monthly, 2-4 vCPU / 4-8 GiB at roughly **$20-$50/mo** (Fly.io mid shared ~$22/mo,
Hetzner from ~€5/mo, DigitalOcean $24-48/mo; approximate as of the `Date:` line).

- **No execution-time ceiling — the deciding constraint.** #620 eliminated Vercel
  functions (Hobby 300s; Pro/Ent 800s, 1800s extended max) and classic Workers
  (CPU 10ms/30s-5min) on execution time alone: no phase can run. Cloudflare
  Containers has no fixed cap on paper but its documented runtime non-guarantee —
  host restarts on an irregular cadence, SIGTERM with a 15-minute grace then
  SIGKILL — reintroduces a ceiling smaller than `factory.json`'s 1800-7200s
  budgets, shorter than a 33-minute CHECK. On a VPS, a container runs until the
  host stops it; only `factory.json:11-17` timeouts apply.
- **Fixed monthly cost fits the bursty pattern.** Idle and burst are equally cheap
  on a flat monthly bill, the opposite of per-second serverless metering that
  accumulates across a 2-hour BUILD and the supervise loop's waiting cycles.
- **Native fit for the supervisor shape.** `cmdRun` fans lanes out in parallel
  (`cli/index.ts:2150-2157`), `runLane` drives issues serially
  (index.ts:2283-2329), and `superviseLoop` runs the whole loop across cycles
  (index.ts:2918) — **one long-lived supervising process per host** that stays
  resident across queue polls, ingests, lane runs, and merges. A full-OS container
  is the only short-list shape that hosts that process unchanged, along with its
  subprocesses, on-disk `.factory/` state (`getFactoryPaths`,
  `packages/core/src/config/index.ts:373-399`), and sibling worktrees
  (`factory.json:22-28`).

**Rejected — Cloudflare Containers**: the serious near-miss (a real Linux
container with DinD and no fixed max runtime), but its ephemeral disk forces
`.factory/` state and sibling worktrees through FUSE/R2, the runtime non-guarantee
reintroduces the ceiling, and the Worker/Durable-Object control plane means a
supervisor rewrite instead of a container entrypoint (all #620). Re-evaluate only
if the factory ever moves to short request-driven phases. **Eliminated on
execution time + no subprocess/persistent-disk model**: Vercel functions and
classic Workers.

## Pick 3 — credential approach: GitHub App installation tokens from a host-side broker

**Chosen** — per-run minted GitHub App installation tokens, following #621's
design direction.

- **Per-run freshness.** An installation token expires after ~1 hour (GitHub docs)
  — roughly the span of a single phase under `factory.json:11-17` (plan 1800s,
  build 7200s, check 1800s) — so one mint per (run, repo, phase) is the natural
  cadence. Fine-grained PATs have a 1-day minimum TTL, so they cannot be per-run
  fresh.
- **Per-repo scoping by construction.** The mint call's
  `repositories`/`repository_ids`/`permissions` body params bound a compromised
  lane to exactly one repo with exactly the phase's minimum permissions. That
  closes the #618 credential-exfiltration blast radius — the one global PAT at
  `cli/index.ts:204` covering every repo — **even while egress stays open**, which
  matters because egress enforcement is deferred (Pick 1 grounds this in
  sandbox/index.ts:114 vs. `factory.json:59`).
- **Instantly revocable.** Suspending/uninstalling the App kills every token it
  minted; fine-grained PAT revocation is a settings-page hunt per token.
- **Consumed exactly where today's PAT is.** `getOctokit()` (cli/index.ts:203-212)
  reads `GITHUB_TOKEN`/`GH_TOKEN` — the broker injects the minted token the same
  way. `git push` stops riding the worktree's inherited credential helper
  (`ship.ts:93`, ship.ts:132) and authenticates via per-run repo-scoped
  `http.extraHeader`/`GIT_ASKPASS` (never a planted `.git-credentials` — the file
  `worktree-gc.ts:42` already hunts via `CREDENTIAL_BASENAMES`, zero-filled by
  `findCredentialFiles` at worktree-gc.ts:77). `FACTORY_MERGE_ADMIN`
  (index.ts:2544) becomes a per-run, per-repo merge decision scoped by an
  admin-capable installation token minted only for the merge phase, instead of a
  host-wide `=== '1'` flag.
- **The broker owns the private keys** on the host, out of the sandbox; it mints
  per (run, repo, phase) and logs every grant so per-run cost attribution stays
  consistent with ADR-0020 (`docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md`)
  — the broker's grant log says which grant served which run.

**Rejected as primary — fine-grained PATs**: bound to a user account, 1-day minimum
TTL (no per-run freshness), minted by a human not per (run, repo, permission-set),
cannot span multiple orgs, awkward to revoke mid-run — they do not shrink the #618
blast radius the way per-run installation tokens do. They remain the
**bootstrap/fallback** for owners that cannot be App-controlled (a new owner
mid-onboarding, a repo whose org blocks GitHub Apps).

**Model keys** — injected via filtered env at spawn through the existing
`laneEnv`/`HarnessRequest.env` seam (`packages/core/src/environment/index.ts:317-323`;
`packages/core/src/harness/index.ts:45-46`; consumed at `build.ts:151`,
check.ts:165, and check.ts:337), replacing the `{ ...process.env, ...opts.env }`
merge (`packages/core/src/utils/exec.ts:57`, exec.ts:141) for sandboxed runs —
never written to disk, never baked into the image. Paired with proxy-enforced
egress (the existing `environment.proxy` seam, `factory.json:93-98`). **The Claude
OAuth sharp corner (#621):** `~/.claude`/`~/.codex` are in `writablePaths` by
default (`sandbox/index.ts:86-87`), and the stored OAuth credential in
`~/.claude/.credentials.json` + macOS keychain
(`packages/core/src/usage/subscription.ts:27-34`) is host-only once per-run injected
keys replace it in the sandbox — so `~/.claude` and `~/.codex` leave
`writablePaths` by default, exactly the #618 write-scope edge (index.ts:82-95).

## How the picks compose

One VPS (Pick 2) runs the existing supervisor as a container — `factory supervise`
unchanged, wired to restart on boot. Per-phase model runs and checker invocations
execute inside stock-Docker sandbox containers on that host (Pick 1: default
seccomp + AppArmor, non-root, no `--privileged`), covering **all four phases**
including PLAN (which today runs unwrapped, cli/index.ts:1093-1113). A host-side
credential broker mints a scoped GitHub App installation token per (run, repo,
phase) and injects it plus the model keys via env (Pick 3); `.factory/` state and
sibling worktrees live on the VPS disk. The broker's grant log keeps per-run cost
attribution consistent with ADR-0020. The v1 `sandbox-exec`/`firejail` envelope
(`packages/core/src/sandbox/index.ts`) is superseded on the host by the Docker
sandbox; fine-grained PATs remain the fallback for non-App-controlled owners.

## Go/no-go spike plan (future work)

The smallest proof that validates the combination, stated explicitly as **future
work, scoped separately, once this lands** — not implemented here:

- **Provision** one 2-4 vCPU / 4-8 GiB VPS (Hetzner or DigitalOcean), install
  Docker.
- **Deploy** the existing factory supervisor unchanged as a container (wired to
  restart on boot).
- **Run one real factory issue end-to-end** (PLAN → BUILD → CHECK → SHIP) with
  build/check runs executing inside stock-Docker sandbox containers (default
  seccomp + AppArmor, non-root, no `--privileged`) on that host; include one repo
  whose tests need Docker-in-Docker if available; authenticate with one minted
  GitHub App installation token (no host PAT).
- **Timed** per phase against the `factory.json:11-17` budgets;
  **cost-tracked** (VPS monthly prorated + per-run marginal + model API spend via
  the existing `cost_tracking` sink, `factory.json:40-44`).

**Go/no-go criteria:**
(a) the full cycle completes in-container with real git/npm/subprocess access;
(b) a real GitHub write lands (PR opened; merge if `FACTORY_MERGE=1`)
authenticated by the minted token, with no `.git-credentials` planted; (c) every
phase within budget and the cycle within ~2x the local baseline; (d) per-run
marginal cost within a stated envelope; (e) no credential leak (sandbox sees only
the scoped token + injected keys; `~/.claude`/`~/.codex` not writable by the
sandbox).

**Go** → scope the migration plan as a separate story. **No-go** → record which
pick failed and re-open the decision with evidence (superseding ADR-0023).

## Sources

All URLs retrieved 2026-08-14. External behavior (token lifetimes, mint endpoints,
hosting pricing and limits) is **approximate as of the `Date:` line and must be
re-checked before the spike scopes the migration**; GitHub's docs and VPS pricing
are the most volatile here.

- GitHub — authenticating as a GitHub App installation (JWT-signed mint at
  `POST /app/installations/{id}/access_tokens`, ~1-hour token lifetime,
  `repositories`/`permissions` body params, git via
  `https://x-access-token:<TOKEN>@github.com/<owner>/<repo>`):
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- GitHub — managing your personal access tokens (fine-grained PATs bound to one
  user/org, `expires_in` 1–366 days or none, the single-org limitation):
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Docker — seccomp profiles (default allowlist denies ~44 of 300+ syscalls):
  https://docs.docker.com/engine/security/seccomp/
- Docker — AppArmor profiles (`docker-default`, auto-loaded):
  https://docs.docker.com/engine/security/apparmor/
- Dependency docs (each labeled a discovery artifact, not a design, that deferred
  its pick to #622):
  - `docs/research/sandbox-tech-comparison.md` (#619) — the sandbox short-list
    this doc picks from
  - `docs/research/hosting-comparison.md` (#620) — the hosting baseline and the
    Cloudflare Containers near-miss this doc resolves
  - `docs/research/hosted-credentials.md` (#621) — the credential design this doc
    operationalizes
  - `docs/research/sandbox-posture-audit.md` (#618) — the v1 envelope this doc's
    picks replace
- Repo grounding — `packages/config/src/factory.json` (timeouts
  factory.json:11-17, merge factory.json:18-21, worktree factory.json:22-28,
  cost_tracking factory.json:40-44, network allowlist factory.json:59, sandbox
  resources factory.json:60, proxy factory.json:93-98),
  `packages/cli/src/cli/index.ts` (getOctokit index.ts:203-212,
  hasGitHubToken index.ts:222-230, shipIssue index.ts:874, phase invocation
  index.ts:1093-1114/1146/1189/1260, cmdRun fan-out index.ts:2150-2157,
  runLane index.ts:2283-2329, superviseLoop index.ts:2918, `--admin` merge
  index.ts:2388/2544), `packages/core/src/phases/{plan,build,check,ship}.ts`
  (entry points and `git push` ship.ts:93/132), `packages/core/src/sandbox/index.ts`
  (v1 envelope), `packages/core/src/utils/exec.ts` (env merge),
  `packages/core/src/environment/index.ts` and `harness/index.ts` (laneEnv seam),
  `packages/core/src/utils/worktree-gc.ts` (credential scrub),
  `packages/core/src/usage/subscription.ts` (Claude OAuth), ADR-0001, ADR-0020 —
  all cited by file:line in the body of this document
