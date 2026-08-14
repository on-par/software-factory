# ADR-0023: Hosted execution runs on a VPS + Docker host with stock-Docker sandboxing and per-run GitHub App installation tokens

- Status: Accepted
- Date: 2026-08-14

## Context

Four discovery docs established the envelope and short-lists but made no pick:
#618 audited the v1 process-level sandbox (write containment works, egress is
open-by-default because a non-empty allowlist is never enforced without a proxy,
PLAN runs uncontained, and the enforcement signal is noise, not evidence); #619
short-listed plain Docker + seccomp/AppArmor as the near-term baseline and
Firecracker microVMs as the strong-isolation target and explicitly deferred the
final pick to this issue; #620 eliminated Vercel functions and classic Workers on
execution time (no phase can run, and neither has a subprocess model), left VPS +
Docker as the baseline with Cloudflare Containers as the serious near-miss; #621
designed per-run minted GitHub tokens and model-key injection but deferred the
operational pick. The factory's real constraints decide the matter: phases run
long (`factory.json:11-17`: plan 1800s, build 7200s, check 1800s; CHECK alone ran
~33 minutes), the supervisor is one long-lived process that shells out to real
git/npm/model-CLI/playwright subprocesses and persists `.factory/` state and
sibling worktrees, some repos' tests need Docker-in-Docker, and the runs perform
real GitHub writes and merges. Under those constraints serverless function hosts
are eliminated, only a full-OS VPS container hosts the supervisor unchanged, and
the near-term sandbox that multiplies across PLAN/BUILD/CHECK/rework with the
least cost and the only native DinD story is stock Docker, while per-run scoped
GitHub App installation tokens are the only mechanism with per-run freshness and
per-repo scoping by construction. These picks are expensive to reverse and
constrain how the credential broker, sandbox wrapper, and deployment are written,
so they are recorded here — subject to validation by the #622 go/no-go spike,
which is future work scoped separately.

## Decision

The factory's hosted execution runs on a self-hosted VPS + Docker host (2-4 vCPU /
4-8 GiB, ~$20-$50/mo) running the existing supervisor unchanged as a container;
agentic build/check runs execute inside stock Docker containers with the default
seccomp profile, the auto-loaded `docker-default` AppArmor profile, a non-root
user, and no `--privileged`; and authentication uses per-run GitHub App
installation tokens minted per (run, repo, phase) by a host-side credential
broker, injected only via env (`GITHUB_TOKEN`) and per-run git credential scoping
(`http.extraHeader` / `GIT_ASKPASS`, never a planted `.git-credentials`), with
model API keys injected via filtered env at spawn through the existing
`HarnessRequest.env` seam, paired with proxy-enforced egress. Fine-grained PATs
remain the bootstrap/fallback for owners that cannot be App-controlled, and
Firecracker microVMs (E2B managed or self-hosted) remain the strong-isolation
escalation target.

## Consequences

Positive: no execution-time ceiling (only `factory.json` timeouts apply, so a
2-hour BUILD and 33-minute CHECK run unremarkably); fixed monthly cost makes idle
and burst equally cheap; the supervisor, its subprocesses, on-disk `.factory/`
state, and sibling worktrees host unchanged; the sandbox replaces the v1
process-level restrictions with a real kernel-boundary + policy surface at zero
marginal cost and with the only fully native Docker-in-Docker story of the
short-list; and per-run installation tokens shrink the #618
credential-exfiltration blast radius to one repo by construction even while egress
enforcement matures. Negative: the Docker sandbox shares the host kernel, so a
container escape remains residual risk (Firecracker is the escalation path); the
VPS is self-hosted ops (provisioning, Docker, reboot-resilient supervisor
container) and its bill is fixed even when idle; a host-side credential broker and
per-run git-credential plumbing are net-new machinery that must be built and
secured; and the picks are Accepted provisionally — the #622 go/no-go spike,
scoped separately, validates them before any migration is planned, and a failed
spike supersedes this ADR.

## References

- [docs/research/sandbox-tech-comparison.md (#619)](sandbox-tech-comparison.md)
- [docs/research/hosting-comparison.md (#620)](hosting-comparison.md)
- [docs/research/hosted-credentials.md (#621)](hosted-credentials.md)
- [docs/research/sandbox-posture-audit.md (#618)](sandbox-posture-audit.md)
- [docs/research/hosted-sandbox-recommendation.md (#622)](../research/hosted-sandbox-recommendation.md)
- [Issue #622](https://github.com/on-par/software-factory/issues/622)
