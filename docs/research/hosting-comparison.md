# Hosting model comparison for factory orchestration (Issue #620)

Date: 2026-08-14

## Purpose and scope

This is the #620 discovery comparison for hosting the factory's
orchestration: Vercel (functions), Cloudflare (classic Workers eliminated on
execution time, **Containers evaluated seriously**), and a **VPS + Docker
baseline** (Fly.io / Hetzner / DigitalOcean). It is a **discovery artifact, not
a design**: it scores each candidate against the factory's real constraints,
states a recommendation **relative to the VPS + Docker baseline**, makes no
final pick, and adds no ADR — the pick belongs to a follow-up, exactly as #619
deferred its final pick to #622. It is sequenced after the dependency issue
**#619** (`docs/research/sandbox-tech-comparison.md`) and runs in parallel with
the **#618** sandbox-execution track (`docs/research/sandbox-posture-audit.md`).
Orchestration hosting and sandboxed code execution are separate concerns even
though the final architecture likely composes both: this document evaluates
only the host for the orchestrator and its phase subprocesses, and references
the sandbox track only for sequencing.

## The factory's orchestration constraints (what each host must fit)

Every dimension below is scored against the factory's real operating frame,
grounded in this checkout:

- **Long-lived runs** — `packages/config/src/factory.json:11-17` sets
  `plan_seconds: 1800`, `build_seconds: 7200`, `check_seconds: 1800`. With
  rework, a full plan → build → check → ship cycle runs an hour or more, and
  CHECK alone ran ~33 minutes (from the issue). A host must sustain a single
  phase for up to 2 hours and a whole cycle for well over an hour without a
  wall-clock or CPU cap.
- **Supervisor shape** — `cmdRun` fans lanes out in parallel via
  `Promise.allSettled` over per-lane promises (`packages/cli/src/cli/index.ts:2150-2157`),
  `runLane` drives issues serially within a lane and parks the lane on failure
  (`index.ts:2283-2329`), and `factory supervise` runs the whole loop across
  cycles (`superviseLoop`, `index.ts:2256-2268`). The unit of deployment is
  **one long-lived supervising process per host**, not one process per request:
  it stays resident across queue polls, ingests, lane runs, and merges.
- **Real subprocess/git/npm/network access** — `shipIssue` sets up a per-issue
  git worktree through `gitFetch`/`setupWorktree` subprocesses
  (`index.ts:958-973`), then drives the four phase entry points: `planPhase`
  (`packages/core/src/phases/plan.ts:149`), `buildPhase`
  (`packages/core/src/phases/build.ts:22`), `checkPhase`
  (`packages/core/src/phases/check.ts:169`), and `shipPhase`
  (`packages/core/src/phases/ship.ts:33`). Each shells out to model CLIs
  (claude/codex/ollama via the harnesses), runs `npm ci`, the checker framework
  (compile/tests/lint/links/accessibility, `packages/core/src/checkers/index.ts`),
  playwright, and `git push`/merge (`ship.ts:93`, `ship.ts:132`). No serverless
  function runtime offers a real subprocess model; the host must be a full OS.
- **On-disk state** — `.factory/events.ndjson`, `.factory/plans/`,
  `.factory/ports.json`, `.factory/queue`, and the lock files all live under
  `<repoRoot>/.factory` (`packages/core/src/config/index.ts:373-399`), and
  per-issue worktrees are created as **siblings of the repo**
  (`worktree.prefix: "ship-it/"`, `worktree.parent: "../"`,
  `factory.json:22-28`). The host must persist state across runs and give each
  lane room for checked-out worktrees and `node_modules`.
- **Usage pattern** — bursty, long-running, low concurrency: occasional
  multi-hour cycles rather than high-frequency short requests. Billing that
  fits is fixed monthly cost with room for idle; billing that punishes is
  per-request/per-duration metering in millisecond or second units applied to
  multi-hour processes.

## Candidate 1 — Vercel (functions)

**What it is.** AWS Lambda-backed "fluid compute" serverless functions,
invoked per HTTP request, priced on Active CPU time (billed per ms of actual
execution) plus Provisioned Memory (billed per GB-hour while an instance has an
in-flight request, including I/O wait), plus per-invocation charges
(`vercel.com/docs/functions/usage-and-pricing`).

**Max execution time: the elimination reason.** Vercel caps a single function
invocation well under an hour: Hobby is **300s (5 min) default and maximum**;
Pro and Enterprise are 300s default, **800s maximum**, with an **1800s
(30-minute) extended maximum** in beta for specific Node.js/Python versions
(`vercel.com/docs/functions/limitations`). Against the factory's real timeouts
(`factory.json:11-17`) that is fatal at every tier: a 30-minute CHECK that
actually ran ~33 minutes (from the issue) exceeds even the extended maximum,
and a 2-hour BUILD (`build_seconds: 7200`) is four times the largest possible
invocation. The request/response framing itself is wrong for a supervisor:
`cmdRun`/`runLane`/`shipIssue` (`cli/index.ts:2150-2157`, index.ts:2283-2329,
index.ts:874) live for the whole queue, not one request, and a function that
terminates at its duration ceiling would kill a phase mid-run (504
`FUNCTION_INVOCATION_TIMEOUT`).

**Cost at the bursty long-running pattern.** There is no idle fee — Hobby
includes 4 Active CPU hours, 360 GB-hours of Provisioned Memory, and 1M
invocations a month, and Pro bills on demand. But the metering units mismatch
the pattern: Provisioned Memory bills for the **entire** in-flight lifetime of
an instance (including I/O wait) even though CPU billing pauses, so a
long-running factory phase would accumulate memory-hours continuously; and
whatever the arithmetic, the ceiling makes the comparison moot — the factory
cannot run at all. An attempt to fit the supervisor would mean a rewrite into
request-driven workers (out of scope per the issue), with no persistent local
disk or subprocess model anywhere in the function boundary.

**Orchestration fit for `packages/cli` + `packages/core`: none.** The CLI's
supervisor and the phases' subprocesses (`git fetch`, `npm ci`, model CLIs,
playwright, `git push`) do not fit a function boundary: functions are
request-scoped, ephemeral-filesystem, no-subprocess runtimes. Hosting the
factory on Vercel would require re-architecting the supervisor into a queue
consumer and moving all subprocess work elsewhere — a rewrite, not a deploy.

## Candidate 2 — Cloudflare

### Classic Workers — eliminated for the same reason

Classic Workers are short-lived, request/CPU-limited isolates with no
subprocess model. CPU time per HTTP request is **10 ms on Free** and **30s by
default on Paid, max 5 min (300,000 ms)**; memory is **128 MB per isolate**
(`developers.cloudflare.com/workers/platform/limits`). A single CHECK phase
runs 30 minutes of wall time and shells out to `npm ci` and model CLIs
(`check.ts:169`); a Worker cannot run subprocesses at all and its CPU budget is
two orders of magnitude too small. Eliminated.

### Cloudflare Containers — evaluated seriously

**What it is.** Serverless Linux containers launched on demand from a Worker
(or Durable Object) control plane, "built for any runtime, any language",
deployable as a Dockerfile; each instance runs inside its own VM
(`developers.cloudflare.com/containers/`). This is the closest serverless
contender to the factory's needs: a real Linux userspace that can run the
supervisor, subprocesses, git, and npm, and Docker-in-Docker is explicitly
supported (rootless `dockerd` with `--iptables=false`).

**Max execution time: no fixed cap on paper, but no runtime guarantee.** The
platform states "Cloudflare does not stop a container instance after a fixed
maximum runtime"; the Container class sleeps after **10 minutes of inactivity**
by default (`sleepAfter`, overrideable) and a host restart can stop an instance
on an **irregular cadence** — Cloudflare "does not guarantee that any container
instance will run for any set period of time." On shutdown the platform sends
SIGTERM, waits **up to 15 minutes** for exit, then SIGKILL
(`developers.cloudflare.com/containers/faq`). That 15-minute grace is shorter
than a 33-minute CHECK and far shorter than a 2-hour BUILD
(`factory.json:11-17`): an instance that happens to be stopped mid-phase loses
the phase. A supervisor that only interacts with GitHub and model APIs between
phases must also keep the container awake across those gaps or restart state
from disk — see the ephemeral-disk problem below. Cold starts are 1–3s
(vendor figure, volatile).

**Resource ceilings.** Six predefined instance types up to **4 vCPU / 12 GiB /
20 GB disk**, custom types 1–4 vCPU / up to 12 GiB / 20 GB disk; image size is
bounded by instance disk
(`developers.cloudflare.com/containers/platform-details/limits`). That is
ample for a lane host — comparable to a mid-size VPS — and well above the
factory's `sandbox.resources` ceiling (`memMb: 4096`, `factory.json:60`).

**Cost at the bursty long-running pattern.** Containers require the **Workers
Paid plan ($5/mo)** and bill per-second on memory, vCPU, and disk: memory
**$0.0000025/GiB-second**, vCPU **$0.000020/vCPU-second**, disk
**$0.00000007/GB-second**, egress **$0.025/GB** (NA/EU), with free allowances of
25 GiB-hours, 375 vCPU-minutes, 200 GB-hours, and 1 TB egress per month
(approximate, volatile). A `standard-2` instance (1 vCPU / 6 GiB / 12 GB)
running one 2-hour BUILD is roughly $0.14 (vCPU) + $0.11 (memory) + $0.006
(disk) ≈ **$0.26 per BUILD**, and a full hour-long cycle ≈ **$0.13** — cheap
per run, and the free allowances likely cover a modest lane budget. But the
metering is duration-based in second units, which is the opposite of the
factory's fixed-cost-friendly pattern: every hour a container stays alive is
metered, including the idle gaps between phases and the supervise loop's
waiting cycles.

**Orchestration fit for `packages/cli` + `packages/core`: the near-miss, not
the fit.** The container itself could run `factory supervise` unchanged as a
long-lived process — subprocesses, git, npm, and on-container disk all work.
Three things keep it from winning: (1) **ephemeral disk** — all container disk
is wiped on restart, so `.factory/` state (`config/index.ts:373-399`) and
sibling worktrees (`factory.json:22-28`) must be shuttled to R2 (FUSE mounts
exist but are not SSD-like) or re-hydrated each wake, exactly the kind of
state choreography the supervisor was not built for; (2) **no runtime
guarantee** — a host restart mid-BUILD with only a 15-minute SIGTERM grace
kills a 2-hour phase, so the platform's own documented behavior reintroduces
the timeout ceiling at a smaller number than `factory.json`'s; and (3) **the
control-plane rewrite** — the container is driven through a Worker + Durable
Object API (`getContainer().fetch()`), so the supervisor cannot simply be a
container entrypoint listening forever; someone has to write the Worker↔DO
lifecycle glue that wakes, keeps awake, and addresses the instance.

## Candidate 3 — VPS + Docker baseline (Fly.io / Hetzner / DigitalOcean)

**What it is.** A plain virtual server running Docker, provisioned monthly: the
thing the factory already runs on locally, moved to a rented host. No platform
execution-time ceiling — a container runs until the host stops it — and no
per-duration metering to accumulate across a 2-hour BUILD.

**Max execution time: none.** The only ceiling is the process's own
`factory.json` timeouts (`factory.json:11-17`); a phase runs as long as it
needs, and a full multi-hour cycle with rework is unremarkable. This is the
constraint the serverless candidates fail, removed by construction.

**Cost at the bursty long-running pattern: fixed monthly, idle-friendly.** All
three fit the pattern because the bill is flat per month and an idle machine
costs the same as a busy one — the opposite of the per-second serverless
metering:

- **Fly.io** (managed-VPS middle ground): `shared-cpu-1x` 1 GB ≈ **$0.0082/hr
  / $5.92/mo**, `shared-cpu-2x` 4 GB ≈ **$0.0309/hr / $22.22/mo**,
  `shared-cpu-4x` 8 GB ≈ **$0.0617/hr / $44.44/mo** (per-second billing with
  monthly cap), volumes **$0.15/GB/mo**, egress **$0.02/GB** (NA/EU); Machine
  lifecycle (wake/suspend) and Dockerfile deploys, with 40%-off reservation
  blocks (approximate, volatile). Suspend-able machines mean a host that is
  _almost_ always-on but can sleep between batches.
- **Hetzner** (raw VPS): shared-vCPU cloud plans from the low single-digit
  €/month (a 2-vCPU/2-GB shared plan is roughly €4.85/mo, approximate and
  volatile), dedicated-vCPU plans higher; generous included traffic, 99.9% SLA,
  GDPR hosting. The cheapest raw baseline.
- **DigitalOcean** (raw VPS): Basic Droplets 1 vCPU/1 GiB **$6/mo**, 2 vCPU/
  4 GiB **$24/mo**, 4 vCPU/8 GiB **$48/mo**, per-second billing with a monthly
  cap since January 2026, egress included in-plan.

A factory-sized host (2–4 vCPU, 4–8 GB) lands at roughly **$20–$50/mo**
regardless of how many multi-hour runs happen that month.

**Orchestration fit for `packages/cli` + `packages/core`: native.** The
supervisor shape (one long-lived process: `cmdRun` fan-out, `runLane` serial
loops, `superviseLoop`, `shipIssue`) is exactly what a Docker container does
best; subprocesses (`git`, `npm ci`, model CLIs, playwright, `git push`), the
on-disk `.factory/` state, and sibling worktrees all work unchanged because the
host is a full OS with persistent disk. Fly.io adds machine lifecycle and
Dockerfile deploys; Hetzner/DO are bare VPSes that need the same Docker + a
`factory supervise` container wired to restart on boot.

## Comparison summary

Approximate, as of the `Date:` line above; external limits and pricing are
volatile and re-checked before any follow-up pick.

| Candidate                  | Max execution time                                                                                                                          | Cost at factory usage (bursty, long-running)                                                                                         | Orchestration fit for `packages/cli` + `packages/core`                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Vercel functions           | **Eliminated** — Hobby 300s; Pro/Ent 800s, 1800s extended max (beta); no single phase (1800–7200s) can run                                  | No idle fee, but per-ms CPU + per-GB-hour memory metering mismatches multi-hour runs (moot — cannot run)                             | **None** — request-scoped, ephemeral disk, no subprocess model; rewrite required, out of scope                              |
| Cloudflare classic Workers | **Eliminated** — CPU 10 ms Free / 30s–5 min Paid; 128 MB/isolate; no subprocess model                                                       | Workers Paid $5/mo + per-request and per-CPU-ms metering (moot — cannot run)                                                         | **None** — short-lived isolates, no subprocess or persistent disk                                                           |
| Cloudflare Containers      | No fixed cap, but **no runtime guarantee** — sleeps after 10 min idle, host restarts on irregular cadence, SIGTERM → 15-min grace → SIGKILL | Workers Paid $5/mo + per-second vCPU/memory/disk billing; ≈$0.26 per 2-hour BUILD (standard-2), free allowances cover modest use     | **Near-miss** — real Linux container (DinD supported), but ephemeral disk, control-plane rewrite, and runtime non-guarantee |
| VPS + Docker baseline      | **None** — container runs until the host stops; only `factory.json` timeouts apply                                                          | **Fixed monthly** — ≈$20–$50/mo for a 2–4 vCPU/4–8 GB host (Fly.io ~$22/mo mid shared, Hetzner from ~€5/mo, DO $24/mo); idle is free | **Native** — one long-lived process, subprocesses, on-disk `.factory/` state, sibling worktrees, git/npm all unchanged      |

## Recommendation relative to the VPS + Docker baseline

- **VPS + Docker stays the baseline.** It is the only candidate with no
  execution-time ceiling (the deciding constraint against `factory.json:11-17`),
  a fixed monthly cost that makes idle and burst equally cheap, and a native
  fit for the supervisor process, its subprocesses, on-disk state, and git/npm.
- **Vercel functions and classic Cloudflare Workers are eliminated on
  execution time** — neither can run a single phase, let alone the supervisor,
  and both lack the subprocess/persistent-disk model the phases require.
- **Cloudflare Containers is the serious near-miss.** It is a real Linux
  container with Docker-in-Docker and no fixed max runtime, and it would run
  `factory supervise` if it had to — but it does not beat the baseline for
  this pattern: ephemeral disk forces `.factory/` state and worktrees through
  FUSE/R2, the documented runtime non-guarantee (host restarts, 15-minute
  SIGTERM grace shorter than a 33-minute CHECK) reintroduces a timeout ceiling,
  and the Worker/Durable-Object control plane means a supervisor rewrite rather
  than a container entrypoint. It is the candidate to re-evaluate if the
  factory ever moves to short request-driven phases or Cloudflare's snapshot
  persistence and runtime guarantees mature.

**No final pick is made here.** This comparison is the decision input for a
follow-up story that weighs the baseline (with Fly.io as the managed middle
ground) against Cloudflare Containers and the cost/ops trade-offs above —
mirroring #619's deferral of its final pick to #622.

## Sequencing note

This document is sequenced after the dependency issue **#619** (the sandbox
technology comparison at `docs/research/sandbox-tech-comparison.md`, which it
builds on for the "what must be hosted" framing) and runs **in parallel with
the #618 sandbox-execution track** (`docs/research/sandbox-posture-audit.md`).
Orchestration hosting and sandboxed code-execution hosting are separate
concerns and are evaluated separately here; the final architecture likely
composes both — e.g. a VPS + Docker host running the orchestrator with a
sandbox boundary for build/check execution — but that composition is for the
follow-up stories, not this document.

## Sources

All URLs retrieved 2026-08-14. Pricing and limits figures are **approximate as
of the `Date:` line and must be re-checked before any follow-up pick**;
Vercel's 1800s extended maximum is beta, Cloudflare Containers pricing and
instance types are the most volatile, and Hetzner's prices are dynamic.

- Vercel — Functions limits (max duration: Hobby 300s; Pro/Ent 800s, 1800s
  extended beta; memory 2/4 GB; fluid compute): https://vercel.com/docs/functions/limitations
- Vercel — Fluid compute pricing (Active CPU per-hour and Provisioned Memory
  per-GB-hour by region; Hobby allowances): https://vercel.com/docs/functions/usage-and-pricing
- Cloudflare — Workers limits (CPU time 10 ms Free / 30s default to 5 min max
  Paid; 128 MB/isolate; no duration cap on HTTP wall time): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare — Containers overview (serverless containers driven by a
  Worker/Durable Object control plane, Dockerfiles): https://developers.cloudflare.com/containers/
- Cloudflare — Containers limits and instance types (up to 4 vCPU / 12 GiB /
  20 GB disk): https://developers.cloudflare.com/containers/platform-details/limits/
- Cloudflare — Containers lifecycle (no fixed max runtime, `sleepAfter` 10 min
  default, host restarts on irregular cadence, SIGTERM → 15-min grace → SIGKILL,
  ephemeral disk, 1–3s cold starts): https://developers.cloudflare.com/containers/platform-details/architecture/
- Cloudflare — Containers FAQ (runtime non-guarantee, Docker-in-Docker with
  `--iptables=false`, FUSE to R2): https://developers.cloudflare.com/containers/faq/
- Cloudflare — pricing (Containers per-second memory/vCPU/disk + egress rates
  and free allowances): https://www.cloudflare.com/pricing/
- Fly.io — resource pricing (shared/performance Machine presets per-second,
  hourly, monthly; volumes $0.15/GB/mo; egress $0.02/GB NA/EU; reservation
  blocks): https://fly.io/docs/about/pricing/
- Hetzner — Cloud product overview (shared vs dedicated vCPU plans, SLA,
  included traffic; prices dynamic): https://www.hetzner.com/cloud/
- DigitalOcean — Droplet pricing (Basic 1 vCPU/1 GiB $6/mo … 4 vCPU/8 GiB
  $48/mo, per-second billing with monthly cap from Jan 2026, egress included):
  https://www.digitalocean.com/pricing/droplets
- Repo grounding — `packages/config/src/factory.json` (timeouts
  factory.json:11-17, worktree factory.json:22-28, sandbox resources
  factory.json:60), `packages/cli/src/cli/index.ts` (cmdRun/runLane/
  superviseLoop/shipIssue), `packages/core/src/phases/{plan,build,check,ship}.ts`,
  `packages/core/src/checkers/index.ts`, `packages/core/src/config/index.ts`
  (`.factory/` state paths), and the sequencing docs
  `docs/research/sandbox-tech-comparison.md` (#619) and
  `docs/research/sandbox-posture-audit.md` (#618) — all cited by file:line in
  the body of this document
