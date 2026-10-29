# Context

Domain terms as the code uses them. Each entry links the module or ADR that owns it. When the code and this file disagree, the code wins; fix this file.

## Terms

### Lane

"Lane" has two live meanings. On the lifecycle bus a lane is one issue's run: `emitLifecycle` in [packages/core/src/bus/index.ts](packages/core/src/bus/index.ts) sets `laneId ?? issue-<n>` ([ADR-0029](docs/adr/0029-lane-lifecycle-events-are-an-in-process-fan-out-never-a-second-source-of-truth.md)). In the daemon a lane is a numeric slot: [packages/core/src/daemon/run-runtime.ts](packages/core/src/daemon/run-runtime.ts) runs queued runs per `run.laneId ?? 1` ([ADR-0103](docs/adr/0103-durable-isolated-daemon-delivery-lanes.md)), and the TUI groups many issues per lane ([packages/tui/src/lane-queue.ts](packages/tui/src/lane-queue.ts)). The GitHub queue's `factory:lane:<name>` label (`LANE_LABEL_PREFIX` in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts), [ADR-0045](docs/adr/0045-github-queue-order-is-explicit-per-lane-label-metadata.md)) names a queue lane. Unifying these meanings is a separate decision.

### Lane slot

The numeric daemon lane (`run.laneId`, default 1) that serialises runs in [packages/core/src/daemon/run-runtime.ts](packages/core/src/daemon/run-runtime.ts); see [ADR-0103](docs/adr/0103-durable-isolated-daemon-delivery-lanes.md).

### Run

One attempt to take one issue through PLAN → BUILD → CHECK → SHIP, ending in a `RunOutcome` (shipped, parked, ...). See [packages/core/src/run/run-issue.ts](packages/core/src/run/run-issue.ts), [packages/core/src/run/outcome.ts](packages/core/src/run/outcome.ts) ([ADR-0054](docs/adr/0054-runoutcome-is-a-core-owned-value-type-park-classification-is-structural-not-instanceof.md)); daemon run records live in [packages/core/src/daemon/run-store.ts](packages/core/src/daemon/run-store.ts).

### Run lock

A fail-fast (never queued) lock that stops two processes from force-recreating the same per-issue worktree and branch. It has two tiers. The checkout tier is `.factory/run.lock`, taken by `run`, `supervise` and `local-small-overnight`, which pick issues dynamically. The issue tier is `.factory/locks/run/<WorkKey>`, taken by `ship`, `run-issue`, `run-brief`, `resume` and each `--run-children` child. Each tier refuses while a live holder of the other exists, so parallel one-shot CLI runs mean different issues, still bounded by claims and `host.maxBuilds` slots. See [docs/ops/run-lock.md](docs/ops/run-lock.md) and [packages/core/src/utils/run-lock.ts](packages/core/src/utils/run-lock.ts).

### Claim

Taking a queued issue for one claimant via a label CAS (`factory:in-progress` plus `factory:claimed-by:<id>`), verified by re-fetch; the smallest claimant id wins. See `claimNext` in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts) and [ADR-0044](docs/adr/0044-claiming-a-queued-issue-is-a-label-cas-verified-by-re-fetch-and-the-smallest-claimant-id-wins.md).

### Lease

A time-bounded hold. The claim lease is the `factory:claim-expires:<epoch>` label with `DEFAULT_CLAIM_LEASE_MS` (15 min) in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts) ([ADR-0104](docs/adr/0104-claim-staleness-is-a-ttl-lease-with-heartbeat-not-host-pid-liveness.md)). Also the per-lane port lease ([packages/core/src/run/ports.ts](packages/core/src/run/ports.ts), which injects `PORT` and `FACTORY_BASE_URL`) and host build-slot leases ([packages/core/src/environment/host-slots.ts](packages/core/src/environment/host-slots.ts)).

### Heartbeat

Periodic renewal that pushes a claim lease's expiry forward so a live run is not reaped as stale: `heartbeat` in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts), [ADR-0104](docs/adr/0104-claim-staleness-is-a-ttl-lease-with-heartbeat-not-host-pid-liveness.md). The local queue judges staleness from the phase-snapshot heartbeat ([ADR-0086](docs/adr/0086-local-queue-entry-staleness-is-judged-from-the-per-issue-phase-snapshot-heartbeat-not-the-queue-files-mtime.md)).

### Park

Stopping a run without shipping, with a `ParkReason`, the `factory:parked` label and one park comment saying why. See [packages/core/src/run/outcome.ts](packages/core/src/run/outcome.ts), [packages/core/src/run/park-comment.ts](packages/core/src/run/park-comment.ts), `PARKED_LABEL` in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts), and [ADR-0054](docs/adr/0054-runoutcome-is-a-core-owned-value-type-park-classification-is-structural-not-instanceof.md).
Issues labeled `factory:needs-design` park as `held` after PLAN; see [approve-design-checkpoint](docs/runbooks/approve-design-checkpoint.md).

### Release

Giving a claim back: `release(issue, outcome)` in [packages/core/src/queue/github-queue.ts](packages/core/src/queue/github-queue.ts) with a `QueueReleaseOutcome` of `queued`, `parked` or `done`. Stale claims are released by `releaseStaleClaims` in [packages/core/src/queue/stale-claims.ts](packages/core/src/queue/stale-claims.ts) ([ADR-0104](docs/adr/0104-claim-staleness-is-a-ttl-lease-with-heartbeat-not-host-pid-liveness.md)). Port leases are released by `releasePortLease` in [packages/core/src/run/ports.ts](packages/core/src/run/ports.ts).

### Rework round

One BUILD re-run fed with CHECK failures, capped by `MAX_REWORK_ROUNDS = 3` in [packages/core/src/phases/check.ts](packages/core/src/phases/check.ts); see [ADR-0017](docs/adr/0017-a-rework-round-where-no-model-ran-is-neutral-for-stuck-accounting-and-classified-by-the-router-s-own-failure-reason.md) and [ADR-0141](docs/adr/0141-a-rework-round-is-classified-as-environment-when-every-round-1-failing-checker-also-fails-on-the-base-sha-decided-before-the-rework-loop.md). CI rework rounds are a separate budget ([packages/core/src/run/ci-rework-loop.ts](packages/core/src/run/ci-rework-loop.ts), [ADR-0162](docs/adr/0162-ci-rework-diffs-are-guarded-against-suppression-and-park-as-ci-failed-suppression-attempt.md)).

### CHECK round

One pass of the CHECK phase: probe the worktree once, run every checker, produce a verdict. The first round plus each rework round is a CHECK round. See [packages/core/src/phases/check.ts](packages/core/src/phases/check.ts) and [ADR-0022](docs/adr/0022-check-probes-the-worktree-once-per-round-and-checkers-consume-those-facts.md).

### Size gate

The gate that decides whether an issue is too big for one pass, judged on planned code size via `estimatePlanSize` and `planOverBudget` in [packages/core/src/readiness/size.ts](packages/core/src/readiness/size.ts). Modes are `file`, `slice`, `stack` and `off`. See [ADR-0165](docs/adr/0165-size-gate-splits-on-planned-code-size-not-criteria-count.md), [ADR-0043](docs/adr/0043-a-tripped-pre-flight-size-gate-files-sub-issues-under-the-original-issue-and-re-queues-them-the-post-plan-gate-still-parks.md) and [ADR-0147](docs/adr/0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md).

### Slice

One of several sequential PRs that deliver an oversized issue under the same issue, tracked in a slice-plan comment: [packages/core/src/readiness/slice-plan.ts](packages/core/src/readiness/slice-plan.ts); see [ADR-0147](docs/adr/0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md) and [ADR-0156](docs/adr/0156-size-gate-slice-mode-never-files-sub-issues-an-over-cap-slice-plan-is-recorded-and-parks-and-the-slice-cap-is-configurable.md).

### Stack

The size-gate mode that ships the slices as a native GitHub stacked PR set built in one run (`nextStackSlice`, `stackSliceBranch` in [packages/core/src/readiness/slice-plan.ts](packages/core/src/readiness/slice-plan.ts)); see [ADR-0161](docs/adr/0161-size-gate-stack-mode-ships-an-oversized-issue-as-a-native-github-stacked-pr-set-built-in-one-run.md).

### Steward

The stuck-run examiner that diagnoses runs parked as fail after 3 rework rounds, or as ci-failed with the PR open: `runSteward` in [packages/core/src/steward/run.ts](packages/core/src/steward/run.ts); see [ADR-0155](docs/adr/0155-the-stuck-run-steward-examines-only-runs-parked-as-fail-after-3-rework-rounds-or-ci-failed-with-the-pr-open-and-never-environment-budget-held-timeout-or-conflict.md).

### Trust tier

The merge autonomy level: T0 human merges (the default), T1 auto-merge with a sampled human hold, T2 auto-merge behind all gates. Sensitive paths and classifier errors fail closed to T0. See [packages/core/src/review/risk.ts](packages/core/src/review/risk.ts), [packages/cli/src/cli/land-risk.ts](packages/cli/src/cli/land-risk.ts), [ADR-0144](docs/adr/0144-merges-follow-a-t0-t1-t2-trust-tier-ladder-where-t0-human-merge-is-the-default-and-sensitive-paths-or-classifier-errors-fail-closed-to-t0.md) and [ADR-0148](docs/adr/0148-a-merge-trust-tier-is-promoted-only-by-a-human-merged-policy-change-on-published-evidence-and-demoted-at-least-one-tier-on-any-slip.md).

### Constitution

The target repo's standards (its agent instruction files plus `.factory/constitution.md`) that PLAN, BUILD and CHECK are held to. See [packages/core/src/constitutions/index.ts](packages/core/src/constitutions/index.ts), the packaged defaults in [packages/config](packages/config), [ADR-0085](docs/adr/0085-constitution-init-only-ever-writes-the-target-repos-factory-constitution-md.md) and [ADR-0117](docs/adr/0117-a-review-resolves-its-constitution-first-hit-ending-in-a-built-in-default-and-a-cross-repo-pr-is-always-contained.md).

### Worktree GC

The sweep that removes, quarantines or keeps lane worktrees from a per-worktree evidence record: [packages/core/src/worktree/worktree-gc.ts](packages/core/src/worktree/worktree-gc.ts), with the decision in [packages/core/src/worktree/worktree-gc-decide.ts](packages/core/src/worktree/worktree-gc-decide.ts); see [ADR-0027](docs/adr/0027-worktree-gc-sources-merge-close-evidence-from-the-github-api-local-git-state-is-only-a-fallback.md) and [ADR-0149](docs/adr/0149-worktree-gc-reaps-a-factory-decomposed-parent-s-worktree-only-when-it-is-clean-has-no-open-pr-and-nothing-unpushed.md).

### Quarantine

Worktree GC moving a heuristically-stale worktree aside (`quarantineRoot`, `quarantineDestination` in [packages/core/src/worktree/worktree-gc.ts](packages/core/src/worktree/worktree-gc.ts)) instead of deleting it; see [ADR-0090](docs/adr/0090-worktree-gc-real-mode-quarantines-the-two-heuristic-stale-reasons-instead-of-deleting.md). ([ADR-0003](docs/adr/0003-quarantine-ollama-command-agent-spike.md) uses "quarantine" for an unrelated, older agent spike.)

### factoryd

The long-running local daemon that holds the repo registry and runs lanes, with a loopback-only HTTP API: [packages/core/src/daemon/factoryd-http.ts](packages/core/src/daemon/factoryd-http.ts), [packages/cli/src/cli/daemon.ts](packages/cli/src/cli/daemon.ts); see [ADR-0034](docs/adr/0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md) and [ADR-0076](docs/adr/0076-the-factoryd-single-instance-guard-is-a-fail-fast-pid-file-not-the-fenced-file-lock.md).

### Base hold

The gate that stops claiming new work while `main` is red. It is persisted when a lane pauses on a broken base SHA and cleared once origin/main moves or its CI goes green (the `base-hold-cleared` event). See [packages/cli/src/cli/base-hold.ts](packages/cli/src/cli/base-hold.ts), [packages/core/src/config/base-health.ts](packages/core/src/config/base-health.ts) and [packages/core/src/events/kinds.ts](packages/core/src/events/kinds.ts).
