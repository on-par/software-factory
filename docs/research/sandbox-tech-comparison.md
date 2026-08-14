# Sandbox technology comparison (Issue #619)

Date: 2026-08-14

## Purpose and scope

This is the #619 discovery comparison for the sandbox series: it surveys how
products that already run untrusted generated code at scale — Lovable, bolt.new,
v0, Replit Agent, and the E2B-style code-execution sandbox providers behind them
— isolate compute, and scores the three realistic candidate families for this
factory: **Firecracker microVMs** (the E2B managed path or self-hosted
Firecracker / Cloud Hypervisor), **gVisor-wrapped Docker**, and **plain Docker +
seccomp/AppArmor** as the low-effort baseline. It is a **discovery artifact, not
a design**: it recommends a short-list of two candidates, makes no final pick,
and adds no ADR — the final pick is tracked separately in #622. It is sequenced
after **#618**'s audit (`docs/research/sandbox-posture-audit.md`) and is framed
against that audit's findings: this document evaluates the candidates as
replacements/closures for the v1 envelope the audit dissected.

## The factory's consumption constraints (what the candidates must fit)

Every dimension below is scored against the factory's real operating frame,
grounded in this checkout:

- **Fresh worktree per run** — ADR-0001
  (`docs/adr/0001-boss-worker-checker-pipeline.md`) runs each phase in an
  isolated per-issue worktree; worktree paths are siblings of the repo root
  (`worktree.prefix: "ship-it/"`, `worktree.parent: "../"` in
  `packages/config/src/factory.json:22-24`). So a sandbox boundary is stood up
  **per run**, and its startup cost multiplies across PLAN/BUILD/CHECK and every
  rework round — a boundary that costs seconds once per host is amortized
  differently from one that costs per-run.
- **Current baseline** — `packages/core/src/sandbox/index.ts`: OS process
  restrictions (`sandbox-exec` on darwin, `firejail` on linux,
  `detectSandboxRuntime` → `'none'` elsewhere, index.ts:33-40), write
  containment + `ulimit` cpu/mem from `factory.json` `sandbox.resources`
  (`cpuMs: 300000`, `memMb: 4096`, factory.json:60), and egress only ever fully
  denied when `network.allow` is empty (index.ts:114, index.ts:138).
- **What #618 found** — from `docs/research/sandbox-posture-audit.md`: write
  containment works; egress is open-by-default whenever the allowlist is
  non-empty (never enforced without a proxy); containment is
  host-tool-dependent (runtime `'none'` passes commands through unchanged);
  PLAN-phase runs are uncontained; and the enforcement signal is noise, not
  evidence. The candidates below are evaluated as replacements/closures for
  that envelope.
- **Wall-clock budget** — `factory.json` `timeouts.build_seconds: 7200`
  (factory.json:13); cold start is tolerable only if the sandbox is ready within
  a small fraction of a run's budget, but a slow boundary that **multiplies
  across phases** is a real cost even when each individual start is fast.
- **Credential posture** — the factory runs with live GitHub write/merge
  credentials and model API keys; per the #618 threat surface, isolation must
  treat a compromised dependency's `postinstall` script or the agent code itself
  as hostile (egress and credential exfiltration are the top two threats).

## Candidate 1 — Firecracker microVMs (E2B managed / self-hosted Firecracker or Cloud Hypervisor)

**What it is.** KVM-backed microVMs — Firecracker by AWS, with Cloud Hypervisor
as the self-hosted alternative — the technology behind E2B and Daytona-style
code-execution sandboxes. Firecracker uses a minimal device model (only 5
emulated devices) and a minimal guest kernel to keep the per-VM attack surface
and footprint small. The managed option is E2B's SDK (the "how
Lovable/bolt.new/v0-style products do it" path: `Sandbox.create()` returns a
running Linux VM); the self-hosted option is running Firecracker/Cloud
Hypervisor on a KVM-capable host with image caching and orchestration.

**Isolation strength: strongest of the three.** Hardware-virtualized per-run
kernel: each run gets its own VM with its own guest kernel, so a kernel exploit
in guest code cannot reach the host kernel or other runs without also breaking
the hypervisor. This is a different threat model than the #618 baseline — the
agent's syscalls terminate in the guest kernel, not the host's. (Caveat: only
as strong as the host's KVM/hypervisor and the VMM's device model; Firecracker's
jailer adds a second line of defense around the VMM process itself.)

**Cold-start latency: VM boot is fast; per-run workload startup dominates.**
Firecracker's design target is booting a microVM in **<125 ms** with <5 MiB of
per-VM memory overhead (vendor claim, see Sources), and it supports up to ~150
microVM creations/second per host. E2B's marketing material advertises roughly
~150 ms per sandbox creation (approximate, vendor claim, volatile). But the
honest per-run cost in the fresh-worktree-per-run frame is **image/rootfs
readiness plus the workload itself**: the toolchain image must be present (warm
cache) or pulled (cold), and the repo checkout + `npm ci` still happen inside
the VM. Score: **VM boot is sub-second, but on a cold image cache the boundary
adds minutes, and that cost repeats per run** unless images are pre-warmed or
snapshotted (E2B supports template snapshots/forking).

**Docker-in-Docker: supported.** Self-hosted, install Docker inside the microVM
image (the VM is a full guest, so nested Docker runs without the host being
affected). Managed, E2B ships a Docker/Docker Compose sandbox template
(see Sources) that installs Docker inside the VM and validates it with a
`hello-world` run. Because each VM is a full guest, nested Docker does not
weaken the outer boundary.

**Rough cost per run-hour: low per-VM list price; managed adds a subscription.**
Managed E2B bills per vCPU-hour + GiB-hour at list rates (e.g. ~$0.000028/s for
the default 2-vCPU sandbox and ~$0.0000045/GiB/s of RAM; a 2-vCPU/4-GiB sandbox
works out to roughly $0.13–$0.18 per run-hour, plus a monthly plan for session
length/concurrency above the free tier — pricing is volatile, see Sources, and
labeled approximate). Self-hosted is roughly the cost of the host instance (a
few cores/GB) plus image-cache and orchestration overhead — cheaper at scale,
expensive in ops (host KVM, image cache, VM lifecycle management).

This is the category that closest matches "how Lovable/bolt.new/v0 do it" per
the issue.

## Candidate 2 — gVisor-wrapped Docker

**What it is.** Docker with gVisor's `runsc` as the container runtime: a
user-space kernel (the Sentry) intercepts the application's syscalls and
services them itself, with a Gofer process mediating filesystem access. No
hardware virtualization; gVisor explicitly positions itself as _not_ a syscall
filter (seccomp/AppArmor) and _not_ a VM.

**Isolation strength: strong process isolation, not full VM isolation.** A
guest syscall goes through the userspace Sentry, so it cannot directly touch the
host kernel — the container-escape _kernel-exploit_ path is substantially
closed. But the Sentry itself is software running on the host, so a gVisor bug,
or an attack surface that does not go through syscalls, remains in reach; there
is no separate guest kernel to fall back on. State plainly: **stronger than
plain Docker, weaker than a microVM.**

**Cold-start latency: small additive overhead over plain Docker.** `runsc`
startup adds on the order of hundreds of ms over `runc` (gVisor's own perf
guide notes that most of the measured Docker startup cost is Docker itself; the
sandbox's structural overhead is per-syscall, which shows up in workloads that
are syscall-bound). The dominant cost in the fresh-worktree-per-run frame is
still image readiness + checkout + install, so the _boundary_ cost is
sub-second while the workload cost is unchanged.

**Docker-in-Docker: supported with caveats — the weakest DinD story of the
three.** Running dockerd inside a `runsc` sandbox works but needs
configuration: `dockerd` must be started with `--iptables=false
--ip6tables=false`, newer Docker versions need `--net-raw` and
`--allow-packet-socket-write` runtime flags, and Docker v29's overlayfs-based
image store conflicts with nested overlay-on-overlay mounts (workarounds: mount
a `tmpfs` at `/var/lib/docker` or disable the containerd image store). This is
"possible with real setup," not turnkey.

**Rough cost per run-hour: zero marginal on the existing host.** It runs on the
existing Docker daemon; the only costs are host capacity and image storage,
which the factory already pays.

## Candidate 3 — plain Docker + seccomp/AppArmor (low-effort baseline)

**What it is.** Stock Docker with the default seccomp profile (an allowlist that
denies ~44 of 300+ syscalls — module loading, `mount`, most namespace/clone
operations, `ptrace`, io_uring after the CVE-2026-31431-era blocks), optionally
the auto-loaded `docker-default` AppArmor profile, a non-root user, and no
`--privileged`. The same tech any CI uses today.

**Isolation strength: weakest of the three.** The guest shares the host kernel;
seccomp/AppArmor shrink the syscall/access surface, but a host-kernel
vulnerability reachable through a permitted path is still exploitable from the
container, and container-escape is the residual risk. This is a real
kernel-boundary + policy surface (a material upgrade over the #618
process-level baseline's "no boundary at all"), but it is **not** a
compromise-resilient one.

**Cold-start latency: fastest of the three.** Sub-second to a few seconds for a
warm image; the per-run checkout/install cost inside is the same as everywhere
else. The boundary itself is effectively free, which matters because it
multiplies across PLAN/BUILD/CHECK and rework rounds.

**Docker-in-Docker: the native case.** Mount the host Docker socket or run a
nested `dockerd`; both are standard, well-trodden setups. **Caveat:** mounting
the host socket weakens the isolation boundary (the container then has daemon
control on the host), which pushes back against the seccomp/AppArmor
containment — the repo that needs DinD for its own tests is exactly the case
where the baseline's weakest point shows.

**Rough cost per run-hour: zero marginal on the existing host.**

## Comparison summary

Approximate, as of the `Date:` line above; cold-start figures for Firecracker
are vendor claims and cost figures are list-price and volatile.

| Candidate                                | Isolation strength                                                                             | Cold-start latency (fresh-worktree-per-run frame)                                                                                       | Docker-in-Docker                                                                                       | Rough cost/run-hour                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Firecracker microVMs (E2B / self-hosted) | **Strongest** — hardware-virtualized per-run kernel, no host-kernel sharing                    | VM boots in <125 ms (design target) / ~150 ms E2B creation, but **image readiness dominates: minutes on a cold cache, repeats per run** | **Supported** — full guest; Docker inside the VM (E2B Docker template) or self-hosted                  | ~$0.13–$0.18 managed per 2-vCPU/4-GiB run-hour (list, volatile); self-hosted ≈ host instance + ops |
| gVisor-wrapped Docker (`runsc`)          | Strong process isolation, **not** full VM — userspace kernel, no guest kernel                  | Small additive overhead (hundreds of ms over `runc`); dominant cost is still image/checkout/install                                     | **Supported with caveats** — dockerd flags, overlay/tmpfs workarounds; weakest DinD story of the three | **Zero marginal** on the existing host                                                             |
| Plain Docker + seccomp/AppArmor          | **Weakest** — shared host kernel; seccomp/AppArmor shrink the surface, escape remains residual | **Fastest** — sub-second to a few seconds warm image; boundary effectively free                                                         | **Native** — socket mount or nested dockerd; socket-mounting weakens the boundary                      | **Zero marginal** on the existing host                                                             |

## Short-list recommendation (2 candidates, final pick deferred)

Against the constraints above, the short-list is:

- **Plain Docker + seccomp/AppArmor** as the near-term, low-effort baseline —
  fastest cold start (which matters because the boundary multiplies across
  phases and rework rounds), zero marginal cost on a host that already runs the
  factory, and the only native DinD story for repos whose tests need Docker. It
  directly replaces the v1 OS-process restriction with a real kernel-boundary +
  policy surface. Its weakness — the shared host kernel — is the #622 decision
  input.
- **Firecracker microVMs** (E2B managed, or self-hosted Firecracker/Cloud
  Hypervisor) as the strong-isolation target — the architecture the reference
  products use, hardware-isolated per-run kernels, and fast VM boot. Its
  image-readiness cold-start cost and the managed-vs-self-hosted cost/ops
  trade-off are the #622 trade-offs to weigh.

gVisor is credible but lands between the two on both isolation and DinD
maturity, so it does not make the short-list.

**The final pick between these two is made in #622 against this comparison and
the factory's lane budget.**

## WebContainers (considered, ruled out)

WebContainers (StackBlitz) is a browser-only runtime: the Node.js process,
filesystem, and npm/git tooling run in the user's browser (via WebAssembly and
Service Workers), not on a server. It provides no real subprocess, network, npm,
or git access outside the browser, whereas the factory needs genuine
filesystem, network, npm, git, and subprocess execution to host a build lane —
so WebContainers cannot host a build lane and is ruled out.

## Sources

All URLs retrieved 2026-08-14. Pricing and latency figures are **approximate as
of the `Date:` line and must be re-checked before #622 makes the pick**; E2B
pricing and Firecracker boot latency are the two most volatile.

- Firecracker — project docs (security-by-design, minimal device model,
  <125 ms startup, <5 MiB footprint, ~150 microVMs/s/host, jailer):
  https://firecracker-microvm.github.io/
- E2B — docs index ("a fast, secure Linux VM created on demand for your agent";
  Docker/Docker Compose sandbox template): https://e2b.dev/docs and
  https://docs.e2b.dev/template/examples/docker.md
- E2B — pricing (per-second vCPU/RAM list rates, Hobby/Pro session-length and
  concurrency limits): https://e2b.dev/pricing
- gVisor — what it is (Sentry/Gofer, runsc, "not a syscall filter, not a VM"):
  https://gvisor.dev/docs/
- gVisor — performance guide (structural vs. implementation costs, startup and
  syscall overhead): https://gvisor.dev/docs/architecture_guide/performance/
- gVisor — Docker-in-gVisor (dockerd flags, net-raw/allow-packet-socket-write,
  overlay/tmpfs workarounds): https://gvisor.dev/docs/tutorials/docker-in-gvisor/
- Docker — seccomp profiles (default allowlist denies ~44 of 300+ syscalls):
  https://docs.docker.com/engine/security/seccomp/
- Docker — AppArmor profiles (`docker-default`, auto-loaded):
  https://docs.docker.com/engine/security/apparmor/
- WebContainers — project docs (browser-based runtime, npm/pnpm/yarn in the
  browser): https://webcontainers.io/
- Repo grounding — `docs/research/sandbox-posture-audit.md` (#618), ADR-0001,
  `packages/core/src/sandbox/index.ts`, `packages/config/src/factory.json`
  (cited by file:line in the body of this document)
