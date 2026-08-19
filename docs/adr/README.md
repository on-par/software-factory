# Architecture Decision Records

An ADR is a short record of one significant architecture decision, the
context that drove it, and its consequences — written down at the time the
decision is made, not reconstructed later. This directory follows the classic
[Michael Nygard ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## When to add one

Add an ADR when a decision:

- **constrains how future code must be written** (e.g. a required pipeline
  shape, a config-as-source-of-truth rule),
- **would be expensive to reverse** (e.g. a data model, a routing
  architecture, a serialization format), or
- **looks arbitrary or wrong from the code alone**, such that an agent or new
  contributor might "fix" it without knowing it was deliberate.

Do **not** write ADRs for reversible implementation details (variable names,
a helper's internal structure, a one-off script) — those belong in code
comments or PR descriptions, if anywhere.

## How

1. Copy the section structure of `0001-boss-worker-checker-pipeline.md`:
   header block (Status, Date) followed by **Context**, **Decision**,
   **Consequences**.
2. Number sequentially: `NNNN-kebab-case-title.md`, using the next free
   number.
3. Status is one of `Proposed`, `Accepted`, `Deprecated`, or `Superseded`.
4. Never rewrite history. To change a past decision, add a new ADR and mark
   the old one `Superseded by ADR-NNNN`.
5. Add a row to the index below.

## Index

| Number                                                                                                                              | Title                                                                                                                | Status   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-boss-worker-checker-pipeline.md)                                                                                        | Boss–worker–checker pipeline with per-issue build routing                                                            | Accepted |
| [0002](0002-structured-logging-via-event-log.md)                                                                                    | Structured logging via the existing event log, not pino                                                              | Accepted |
| [0003](0003-quarantine-ollama-command-agent-spike.md)                                                                               | Quarantine the Ollama command-agent spike behind the experimental flag                                               | Accepted |
| [0004](0004-narrow-public-core-api.md)                                                                                              | A narrow public API for `@on-par/factory-core`                                                                       | Accepted |
| [0006](0006-proposer-export-is-pure-github-filing-goes-through-an-injected-port.md)                                                 | Proposer export is pure; GitHub filing goes through an injected port                                                 | Accepted |
| [0007](0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md)                               | SlopCodeBench baseline correctness derives only from retained native SCBench evidence                                | Accepted |
| [0008](0008-slopcodebench-problem-inputs-come-from-a-pinned-scb-problems-revision-injected-via-scbench-problems-path.md)            | SlopCodeBench problem inputs come from a pinned scb-problems revision injected via SCBENCH_PROBLEMS_PATH             | Accepted |
| [0009](0009-fenced-steal-of-stale-file-locks.md)                                                                                    | Stealing a stale file lock is fenced by a sibling steal-arbiter directory                                            | Accepted |
| [0010](0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md)                                             | The readiness size gate re-implements the INVEST "small" rule inside core                                            | Accepted |
| [0011](0011-the-size-gate-kpi-is-a-binary-per-run-score-with-rate-and-mean-on-different-denominators.md)                            | The size-gate KPI is a binary per-run score, with rate and mean on different denominators                            | Accepted |
| [0012](0012-the-post-merge-defect-rate-is-scored-on-a-delayed-window-closed-cohort-not-on-all-runs.md)                              | The post-merge defect rate is scored on a delayed, window-closed cohort, not on all runs                             | Accepted |
| [0013](0013-kpis-subpath-export-for-browser-safe-kpi-consumers.md)                                                                  | A fourth subpath export, `./kpis`, for browser-safe KPI consumers (amends ADR-0004)                                  | Accepted |
| [0014](0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)                                                    | The CI merge gate fails closed on any conclusion outside the passing allow-list                                      | Accepted |
| [0015](0015-a-check-run-set-is-final-only-after-a-settle-window.md)                                                                 | A check-run set is final only after a settle window or a caller-declared minimum count                               | Accepted |
| [0016](0016-waitformerge-parks-the-lane-on-sustained-or-permanently-failing-merge-state-checks.md)                                  | waitForMerge parks the lane on sustained or permanently-failing merge-state checks                                   | Accepted |
| [0017](0017-a-rework-round-where-no-model-ran-is-neutral-for-stuck-accounting-and-classified-by-the-router-s-own-failure-reason.md) | A rework round where no model ran is neutral for stuck accounting and classified by the router's own failure reason  | Accepted |
| [0018](0018-a-dedup-index-is-never-derived-from-an-unverified-gh-listing.md)                                                        | A dedup index is never derived from an unverified `gh` listing                                                       | Accepted |
| [0019](0019-the-codex-harness-reads-token-usage-from-codex-exec-json-trading-away-the-stderr-model-banner.md)                       | The codex harness reads token usage from `codex exec --json`, trading away the stderr model banner                   | Accepted |
| [0020](0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md)                             | Cost KPIs are scored on cost-bearing cohorts, and absent cost data is unknown, never zero                            | Accepted |
| [0021](0021-the-frozen-spec-artifact-set-is-owned-by-a-single-spec-module.md)                                                       | The frozen spec artifact set is owned by a single spec module                                                        | Accepted |
| [0022](0022-check-probes-the-worktree-once-per-round-and-checkers-consume-those-facts.md)                                           | CHECK probes the worktree once per round and checkers consume those facts                                            | Accepted |
| [0023](0023-hosted-execution-on-vps-docker-with-stock-docker-sandboxing-and-github-app-installation-tokens.md)                      | Hosted execution runs on a VPS + Docker host with stock-Docker sandboxing and per-run GitHub App installation tokens | Accepted |
| [0024](0024-hosted-execution-runs-on-a-vps-docker-host-with-stock-docker-sandboxing-and-per-run-github-app-installation-tokens.md)  | Hosted execution runs on a VPS + Docker host with stock-Docker sandboxing and per-run GitHub App installation tokens | Accepted |
| [0025](0025-autonomous-cloud-provisioning-requires-a-human-approved-plan.md)                                                        | Autonomous cloud provisioning requires a human-approved plan gate                                                    | Accepted |
| [0026](0026-autonomous-cloud-provisioning-requires-a-human-approved-plan-gate.md)                                                   | Autonomous cloud provisioning requires a human-approved plan gate                                                    | Accepted |
| [0027](0027-worktree-gc-sources-merge-close-evidence-from-the-github-api-local-git-state-is-only-a-fallback.md)                     | Worktree GC sources merge/close evidence from the GitHub API; local git state is only a fallback                     | Accepted |
| [0028](0028-a-ship-push-whose-success-the-pr-depends-on-is-verified-never-best-effort.md)                                           | A SHIP push whose success the PR depends on is verified, never best-effort                                           | Accepted |
| [0029](0029-lane-lifecycle-events-are-an-in-process-fan-out-never-a-second-source-of-truth.md)                                      | Lane lifecycle events are an in-process fan-out, never a second source of truth                                      | Accepted |
| [0030](0030-a-closed-target-issue-is-skipped-before-any-resource-is-committed-and-the-skip-is-not-a-park.md)                        | A closed target issue is skipped before any resource is committed, and the skip is not a park                        | Accepted |
| [0031](0031-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md)                                                     | factoryd's HTTP API is authorized by its loopback binding alone                                                      | Accepted |
