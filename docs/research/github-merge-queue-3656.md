# GitHub Merge Queue Evaluation (Issue #3656)

Date: 2026-11-05

Status: evaluation (not enabled)

## Context

The factory now lands PRs from more than one host: a local factory and Foreman containers. Priority
for a cross-host fix was raised on 2026-11-05.

ADR-0170 deferred GitHub merge queue. Its reasons:

- The queue builds a `merge_group` commit, not the PR head.
- That conflicts with the ADR-0146 pin to the CI-verified head sha.
- Required workflows need `merge_group` triggers.
- The queue is plan-gated.

Dependencies:

- #3957, shipped as ADR-0175 (commit c3c95ec2): defer and retry a land starved by a moving base.
- #3654: land behind-sync.
- The ops ruleset bypass fix.

This note is a go/no-go input for Patrick. Nothing is enabled or implemented.

## Current land path

In `packages/cli/src/cli/land-pr.ts`, `mergeVerifiedHead` runs under `withLock`.

- It re-reads the PR state.
- It calls `syncReason(verifiedSha)`. It syncs up to `MAX_LAND_SYNC_ROUNDS` (from `land-behind.ts`,
  using `probeHeadBehindBase`).
- It checks `baseGate` (ADR-0171).
- It calls `squashMergeAndDelete(..., { sha: verifiedSha })`.

In `packages/cli/src/cli/land-merge.ts`, `squashMergeAndDelete`:

- calls `pulls.merge({ merge_method: 'squash', sha })`, or under `--admin` runs
  `gh pr merge --admin --squash --delete-branch --match-head-commit <sha>`;
- then deletes the branch ref;
- refuses a stacked base (`factory/*`, #3916).

When the base starves, the land raises `LandDeferredError`. The lane retries it in the landing slot
(ADR-0175).

## What merge queue changes

The queue builds a temporary `gh-readonly-queue/main/pr-<n>-<sha>` branch. It holds main, the PRs
ahead of this one, and this PR. It runs required checks on the `merge_group` event. It
fast-forwards main only when they pass.

Branch protection with a queue rejects a direct `pulls.merge`. So `squashMergeAndDelete` as written
stops working. The queue's merge method (squash) is set in the ruleset, not per call.

## Interaction with squashMergeAndDelete and ADR-0146

The conflict: ADR-0146 pins the merge to the CI-verified head sha. It treats a head-moved refusal as
CI-unverified, never retried. With a queue, GitHub does the merge, not a factory call that carries
`sha`.

Proposed resolution: move the pin from merge to enqueue.

- Enqueue through GraphQL `enqueuePullRequest(input: { pullRequestId, expectedHeadOid: verifiedSha })`.
  Verify against GitHub docs before enablement.
- If the head moves after enqueue, GitHub drops the PR from the queue.
- The factory maps a dequeue for a head change to the existing `CiUnverifiedError` path. ADR-0146
  semantics are preserved.

The verified-tip guarantee becomes stronger. CI runs on the prospective tip itself, not only on
"head contains main".

Land-flow changes a later implementation would need:

- A queue-aware branch in `squashMergeAndDelete`, or a new `enqueueAndAwait` helper. Select it by
  config such as `land.mergeQueue: true`, default off. That flag would follow ADR-0160 if it ever
  tightens validation.
- Wait for the PR to reach `MERGED`, or be dequeued, outside the land lock. ADR-0037 keeps the lock
  for git mutations only.
- Map dequeue reasons:
  - CI failure on the merge group: `CiFailedError`.
  - Head moved, conflict, or removed: `CiUnverifiedError`.
  - Timeout: `LandDeferredError` and the ADR-0175 retry.
- Delete the branch after merge. The queue does not delete it unless the repo setting is on.
- `--admin` is incompatible with the queue. It bypasses the queue, which ADR-0170 forbids. The admin
  path must be refused while the queue is on, except the merge-policy bypass cases.
- The behind-sync from ADR-0170 and #3654 becomes optional pre-queue hygiene, not the gate.
- `baseGate` (ADR-0171) still applies before enqueue.

## Workflow changes for merge_group

Steps that call `gh pr` or read `github.event.pull_request.*` must be guarded with
`if: github.event_name == 'pull_request'`.

### `.github/workflows/ci.yml`

```diff
 on:
   push:
     branches: [main]
   pull_request:
     branches: [main]
+  merge_group:
+    types: [checks_requested]
```

The concurrency group is already `ci-${{ github.ref }}`. A merge group has its own
`gh-readonly-queue/...` ref, so queue groups do not cancel each other. The required `ci` aggregate
job must run on `merge_group`. It has no event filter today, so it will.

### `.github/workflows/codeql.yml`

```diff
 on:
   push:
     branches: [main]
   pull_request:
     branches: [main]
+  merge_group:
+    types: [checks_requested]
   schedule:
```

The alternative is to move CodeQL out of the required checks. That saves minutes but drops the
check from the tip. The ADR-0162 CodeQL gating and attribution code reads checks by PR head sha. A
merge-group run is invisible to it.

### `.github/workflows/secret-scan.yml`

```diff
 on:
   push:
     branches: [main]
   pull_request:
     branches: [main]
+  merge_group:
+    types: [checks_requested]
```

Check that the diff range works with no `pull_request` base. Pass the shas through step `env`,
never inline them in `run:`:

```yaml
env:
  BASE_SHA: ${{ github.event.merge_group.base_sha }}
  HEAD_SHA: ${{ github.event.merge_group.head_sha }}
```

The scan step then reads `"$BASE_SHA"` and `"$HEAD_SHA"`.

### Other workflows

Non-required workflows need no change: factory.yml, factory-run.yml, nightly-*, publish.yml,
discord, triage.

Operator repos that use the reusable `factory-run.yml` workflow do not need the queue. The queue is
opt-in per repo.

## Cross-host ordering

ADR-0037 is a local file lock. ADR-0175 is a host landing slot. Neither orders merges across hosts.
Two hosts can both pass the behind check and race.

Strict protection (ADR-0170) makes the loser re-sync. That causes starvation and deferral.

The queue is a single server-side FIFO shared by all hosts. Each entry is tested on top of the
entries ahead of it. There is no race and no re-sync loop.

Residual issues:

- Queue position fairness between hosts.
- A host that dies after enqueue. The PR still merges. The lane state must reconcile through
  ADR-0174 run-state.

## Plan gating and ops cost

Plan gating: org-owned public repos, or Enterprise Cloud for private repos. Verify this before
enablement.

Ops cost:

- Extra CI minutes. Every merge group reruns the full CI matrix and CodeQL. Estimate: roughly one
  extra full CI run per landed PR, plus reruns when a group ahead fails.
- Ruleset upkeep.
- A required-check name sync between PR and `merge_group` runs.
- Monitoring for a stalled queue.

**No queue enablement until #3654 ships and Patrick approves the ops cost.** The enablement work
needs its own issue and an ADR that amends ADR-0170 and ADR-0146.

## Rollback

Steps for a stalled queue:

1. Detect the stall: queue entries older than N times the CI duration, or `land-deferred` spikes.
2. Turn off the factory flag (`land.mergeQueue: false`) first. New lands use the ADR-0170 path.
3. Remove the merge-queue rule from the `main` ruleset (Settings → Rules, or `gh api` on the
   rulesets endpoint). Keep strict required checks on.
4. Requeue or re-land the PRs that were in the queue. They fall back to the normal land with
   behind-sync.
5. Leave the `merge_group` triggers in place. They are inert without a queue.

Never use `--admin` to drain a stalled queue past a FAILURE (merge-policy).

## Open questions

1. Does GitHub's `expectedHeadOid` on `enqueuePullRequest` behave as assumed, and does a head push
   always dequeue the PR?
2. Does the target plan (org-owned or Enterprise Cloud) include merge queue for the repos that need it?
3. Is the roughly one-extra-CI-run-per-PR cost acceptable, or should CodeQL leave the required set?

## References

- ADR-0037: land locks cover git mutations only.
- ADR-0146: merges pinned to the CI-verified head sha.
- ADR-0162: CI rework suppression guard and CodeQL attribution.
- ADR-0170: land syncs a behind PR under strict branch protection.
- ADR-0171: hosted base CI gates merges.
- ADR-0174: run state persisted in a PR comment.
- ADR-0175: starved land deferred under a host landing slot.
- #3957, #3654, #3916.
- `packages/cli/src/cli/land-pr.ts`, `packages/cli/src/cli/land-merge.ts`,
  `packages/cli/src/cli/land-behind.ts`.
