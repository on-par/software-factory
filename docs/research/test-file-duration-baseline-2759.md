# Test-file duration baseline: per-file times and the 10 slowest files (Issue #2759)

Date: 2026-10-13

## Summary

Baseline for the 50% run-time target in #2736, measured once on main with the
required `npm test` configuration (serial, coverage on).

| Rank | File                                             | Duration (s) | % of summed file time |
| ---- | ------------------------------------------------ | ------------ | --------------------- |
| 1    | `packages/cli/src/cli/octokit.test.ts`           | 27.04        | 24.3                  |
| 2    | `packages/core/src/phases/check.test.ts`         | 18.50        | 16.6                  |
| 3    | `packages/cli/src/cli-commands.test.ts`          | 5.35         | 4.8                   |
| 4    | `packages/cli/src/cli/reset.test.ts`             | 5.02         | 4.5                   |
| 5    | `packages/core/src/sim/pipeline.test.ts`         | 4.92         | 4.4                   |
| 6    | `packages/core/src/utils/index.test.ts`          | 4.61         | 4.1                   |
| 7    | `packages/core/src/daemon/run-runtime.test.ts`   | 3.30         | 3.0                   |
| 8    | `packages/core/src/checkers/index.test.ts`       | 3.02         | 2.7                   |
| 9    | `packages/core/src/utils/command-runner.test.ts` | 2.39         | 2.1                   |
| 10   | `packages/core/src/phases/build.test.ts`         | 2.21         | 2.0                   |

- Combined top-10 duration: **76.35 s** (76,354.8 ms), 68.5% of the 111.45 s
  summed over all 439 files.
- Total tests: **9141** (9140 passed, 0 failed, 1 skipped), 439 test files, 2121 suites.
- Coverage: **98.26% lines**, **92.13% branches** (statements 97.40%, functions 96.62%).

## Context

#2736 wants the suite's run time cut by 50%, but which files are slow was a
guess: `cli-commands.test.ts`, `cli.test.ts`, `phases/plan.test.ts`,
`phases/check.test.ts`, `run/run-issue.test.ts`, `utils/worktree-gc.test.ts`.
This note measures it. It changes no test, source, config or worker setting.

Of the guessed files, only `phases/check.test.ts` (rank 2, 18.50 s) and
`cli-commands.test.ts` (rank 3, 5.35 s) are in the top 10. `cli.test.ts` is
rank 46 (0.21 s), `run/run-issue.test.ts` rank 42 (0.28 s),
`utils/worktree-gc.test.ts` rank 78 (0.07 s) and `phases/plan.test.ts` rank 70
(0.09 s). The slowest file overall, `cli/octokit.test.ts`, was not on the
guessed list.

## Machine

- Mac Mini, 10 cores (`hw.ncpu`=10), 16 GB RAM (`hw.memsize`=17179869184),
  Darwin 27.0.0 (arm64)
- Node v26.6.0, vitest 5.0.3 (installed version)
- Commit `c02f158323a4abd99c3c2e2d1d90229486507c0f` (main, plus this note)
- Load average at start of the measured run (`uptime`): 4.19 3.86 4.03

## Method

`FACTORY_TEST_MAX_WORKERS` unset, so the run is serial, as in `npm test`
(`NODE_OPTIONS=--max-old-space-size=16384 vitest run --coverage`). Only the
reporters were added:

```bash
rm -rf coverage
NODE_OPTIONS=--max-old-space-size=16384 /usr/bin/time -l \
  npx vitest run --coverage --reporter=default --reporter=json \
  --outputFile.json=.tmp/vitest-2759.json > .tmp/vitest-2759.log 2>&1
```

Per-file duration is `endTime - startTime` from the json report's
`testResults[]`, made repo-relative and sorted descending by a throwaway script
in the gitignored `.tmp/` (not committed). Coverage totals come from
`coverage/coverage-summary.json`.

Result: exit 0; vitest `Duration` 177.20 s, wall-clock 178.19 s (`time -l`),
max RSS 0.61 GB. Vitest's `Duration` is larger than the 111.45 s file sum
because it includes transform, setup and collect time.

## Caveats

- One sample. Run-to-run noise was not measured.
- The host is shared; the load average above was about 4 at start.
- Coverage instrumentation inflates every file's time.
- A first run in a fresh worktree failed (4 files, 8 tests; 206 s) because
  `npm run build` had not been run: the pack test says it needs a build, and the
  `run-config`, `run-crash` and `checkers/index` failures cleared once `dist/`
  existed. The measured run above was made after `npm ci` and `npm run build`,
  with no test or source edits. The failed run's figures are not used.

## Full per-file report

<details>
<summary>All 439 test files, sorted by duration</summary>

| Rank | File                                                                       | Duration (s) |
| ---- | -------------------------------------------------------------------------- | ------------ |
| 1    | `packages/cli/src/cli/octokit.test.ts`                                     | 27.04        |
| 2    | `packages/core/src/phases/check.test.ts`                                   | 18.50        |
| 3    | `packages/cli/src/cli-commands.test.ts`                                    | 5.35         |
| 4    | `packages/cli/src/cli/reset.test.ts`                                       | 5.02         |
| 5    | `packages/core/src/sim/pipeline.test.ts`                                   | 4.92         |
| 6    | `packages/core/src/utils/index.test.ts`                                    | 4.61         |
| 7    | `packages/core/src/daemon/run-runtime.test.ts`                             | 3.30         |
| 8    | `packages/core/src/checkers/index.test.ts`                                 | 3.02         |
| 9    | `packages/core/src/utils/command-runner.test.ts`                           | 2.39         |
| 10   | `packages/core/src/phases/build.test.ts`                                   | 2.21         |
| 11   | `scripts/pack-hygiene.test.ts`                                             | 2.18         |
| 12   | `scripts/fixtures/agents/agents.test.ts`                                   | 1.95         |
| 13   | `packages/core/src/checkers/baseline.test.ts`                              | 1.80         |
| 14   | `packages/cli/src/cli/runs-diffstat.test.ts`                               | 1.78         |
| 15   | `packages/core/src/sim/monte-carlo.test.ts`                                | 1.41         |
| 16   | `packages/core/src/utils/lock.test.ts`                                     | 1.25         |
| 17   | `packages/core/src/daemon/run-crash.test.ts`                               | 1.22         |
| 18   | `packages/core/src/phases/opencode-only.e2e.test.ts`                       | 1.08         |
| 19   | `packages/core/src/checkers/design-smells.test.ts`                         | 1.00         |
| 20   | `packages/core/src/phases/codex-only.e2e.test.ts`                          | 0.99         |
| 21   | `packages/core/src/harness/command.test.ts`                                | 0.90         |
| 22   | `packages/core/src/utils/exec.test.ts`                                     | 0.79         |
| 23   | `packages/core/src/daemon/ship-executor.test.ts`                           | 0.77         |
| 24   | `packages/cli/src/cli/first-run.test.ts`                                   | 0.73         |
| 25   | `packages/core/src/router/worktree-state.test.ts`                          | 0.69         |
| 26   | `packages/core/src/environment/index.test.ts`                              | 0.67         |
| 27   | `packages/cli/src/cli/github-stub.test.ts`                                 | 0.61         |
| 28   | `packages/core/src/logger/index.test.ts`                                   | 0.59         |
| 29   | `packages/core/src/sim/ship-phase-breakdown-cli.test.ts`                   | 0.54         |
| 30   | `packages/core/src/sim/monte-carlo-cli.test.ts`                            | 0.54         |
| 31   | `packages/core/src/daemon/run-worktree.test.ts`                            | 0.53         |
| 32   | `packages/core/src/logger/concurrency.test.ts`                             | 0.52         |
| 33   | `packages/scbench-adapter/src/retry-checkpoint.test.ts`                    | 0.50         |
| 34   | `packages/scbench-adapter/src/run-checkpoint.test.ts`                      | 0.47         |
| 35   | `packages/core/src/sim/workspace.test.ts`                                  | 0.40         |
| 36   | `packages/cli/src/cli/daemon.test.ts`                                      | 0.39         |
| 37   | `packages/core/src/daemon/run-config.test.ts`                              | 0.39         |
| 38   | `packages/core/src/events/index.test.ts`                                   | 0.37         |
| 39   | `packages/core/src/sandbox/egress-proxy.test.ts`                           | 0.33         |
| 40   | `packages/core/src/daemon/run-lanes.test.ts`                               | 0.30         |
| 41   | `packages/tui/src/components/App.test.tsx`                                 | 0.30         |
| 42   | `packages/core/src/run/run-issue.test.ts`                                  | 0.28         |
| 43   | `packages/core/src/utils/supervised-exec.test.ts`                          | 0.25         |
| 44   | `packages/core/src/test-support/index.test.ts`                             | 0.23         |
| 45   | `packages/core/src/utils/worktree-location.test.ts`                        | 0.23         |
| 46   | `packages/cli/src/cli.test.ts`                                             | 0.21         |
| 47   | `packages/scbench-adapter/src/workspace.test.ts`                           | 0.21         |
| 48   | `packages/core/src/utils/git-exec.test.ts`                                 | 0.20         |
| 49   | `packages/core/src/logger/repo-slug.test.ts`                               | 0.20         |
| 50   | `packages/core/src/environment/process-groups.test.ts`                     | 0.19         |
| 51   | `packages/core/src/harness/github-credential-isolation.test.ts`            | 0.19         |
| 52   | `packages/core/src/run/ports.test.ts`                                      | 0.18         |
| 53   | `packages/cli/src/cli/logs.test.ts`                                        | 0.18         |
| 54   | `packages/dashboard/src/KpiTrendView.test.tsx`                             | 0.17         |
| 55   | `packages/dashboard/src/App.test.tsx`                                      | 0.17         |
| 56   | `packages/dashboard/src/AttachRepoForm.test.tsx`                           | 0.16         |
| 57   | `packages/scbench-adapter/src/baseline.test.ts`                            | 0.16         |
| 58   | `packages/dashboard/src/SettingsView.test.tsx`                             | 0.16         |
| 59   | `packages/core/src/run/state.test.ts`                                      | 0.14         |
| 60   | `packages/scbench-adapter/src/run-suite-rework.test.ts`                    | 0.14         |
| 61   | `packages/scbench-adapter/src/circuit_eval-replay.test.ts`                 | 0.14         |
| 62   | `packages/core/src/models/index.test.ts`                                   | 0.13         |
| 63   | `packages/core/src/queue/reprioritization-audit.test.ts`                   | 0.13         |
| 64   | `packages/dashboard/src/LaneBoard.test.tsx`                                | 0.13         |
| 65   | `packages/core/src/approvals/index.test.ts`                                | 0.12         |
| 66   | `packages/core/src/review/contained.test.ts`                               | 0.11         |
| 67   | `packages/server/src/index.test.ts`                                        | 0.10         |
| 68   | `packages/core/src/daemon/factoryd-http.test.ts`                           | 0.10         |
| 69   | `packages/core/src/config/index.test.ts`                                   | 0.10         |
| 70   | `packages/core/src/phases/plan.test.ts`                                    | 0.09         |
| 71   | `scripts/fixtures/smoke-repo/smoke-repo.test.ts`                           | 0.08         |
| 72   | `packages/dashboard/src/RepoList.test.tsx`                                 | 0.08         |
| 73   | `packages/dashboard/src/RepoDetail.test.tsx`                               | 0.08         |
| 74   | `packages/core/src/router/index.test.ts`                                   | 0.08         |
| 75   | `packages/product/src/cli/program.test.ts`                                 | 0.08         |
| 76   | `packages/core/src/checkers/base-health.test.ts`                           | 0.08         |
| 77   | `packages/dashboard/src/UsageHeadroom.test.tsx`                            | 0.07         |
| 78   | `packages/core/src/utils/worktree-gc.test.ts`                              | 0.07         |
| 79   | `packages/core/src/daemon/repos-attach.test.ts`                            | 0.06         |
| 80   | `packages/core/src/daemon/engine-supervisor.test.ts`                       | 0.06         |
| 81   | `packages/core/src/harness/opencode.test.ts`                               | 0.06         |
| 82   | `packages/scbench-adapter/src/python-shim.test.ts`                         | 0.06         |
| 83   | `packages/core/src/daemon/process-ownership.test.ts`                       | 0.06         |
| 84   | `packages/scbench-adapter/src/collect-trial.test.ts`                       | 0.06         |
| 85   | `packages/core/src/daemon/checkout-validation.test.ts`                     | 0.06         |
| 86   | `packages/core/src/utils/codex-config.test.ts`                             | 0.05         |
| 87   | `packages/tui/src/tabs/HealthTab.test.tsx`                                 | 0.05         |
| 88   | `packages/core/src/constitutions/index.test.ts`                            | 0.05         |
| 89   | `packages/cli/src/cli/doctor.test.ts`                                      | 0.05         |
| 90   | `packages/core/src/daemon/run-http.test.ts`                                | 0.05         |
| 91   | `packages/tui/src/tabs/CostsTab.test.tsx`                                  | 0.05         |
| 92   | `packages/tui/src/components/Dashboard.test.tsx`                           | 0.05         |
| 93   | `packages/core/src/steward/packet.test.ts`                                 | 0.04         |
| 94   | `packages/core/src/config/example.test.ts`                                 | 0.04         |
| 95   | `packages/scbench-adapter/src/cli-run.test.ts`                             | 0.04         |
| 96   | `packages/tui/src/components/LaneRow.test.tsx`                             | 0.04         |
| 97   | `packages/core/src/harness/claude-cli.test.ts`                             | 0.04         |
| 98   | `packages/tui/src/components/RunDetail.test.tsx`                           | 0.04         |
| 99   | `packages/core/src/config/repo.test.ts`                                    | 0.04         |
| 100  | `packages/tui/src/components/LaneView.test.tsx`                            | 0.04         |
| 101  | `packages/core/src/config/policy.test.ts`                                  | 0.04         |
| 102  | `packages/tui/src/components/ApprovalPrompt.test.tsx`                      | 0.03         |
| 103  | `packages/tui/src/tabs/QueueTab.test.tsx`                                  | 0.03         |
| 104  | `packages/core/src/config/repo-config-file.test.ts`                        | 0.03         |
| 105  | `packages/core/src/steward/diagnose.test.ts`                               | 0.03         |
| 106  | `packages/core/src/hosted/prepare-workspace-disposable-docker.test.ts`     | 0.03         |
| 107  | `packages/tui/src/tabs/LogTab.test.tsx`                                    | 0.03         |
| 108  | `packages/core/src/harness/codex-cli.test.ts`                              | 0.03         |
| 109  | `packages/core/src/local-small/stepwise.test.ts`                           | 0.03         |
| 110  | `packages/core/src/router/cli-executor.test.ts`                            | 0.03         |
| 111  | `packages/core/src/sim/model.test.ts`                                      | 0.03         |
| 112  | `packages/core/src/proxy/index.test.ts`                                    | 0.03         |
| 113  | `packages/cli/src/cli-migrate.test.ts`                                     | 0.03         |
| 114  | `packages/core/src/config/v2.test.ts`                                      | 0.03         |
| 115  | `packages/core/src/phases/ship.test.ts`                                    | 0.03         |
| 116  | `packages/core/src/harness/effort.test.ts`                                 | 0.03         |
| 117  | `packages/core/src/harness/ollama-agentic.test.ts`                         | 0.03         |
| 118  | `packages/core/src/run/phase-snapshot.test.ts`                             | 0.03         |
| 119  | `packages/tui/src/components/SteeringComposer.test.tsx`                    | 0.03         |
| 120  | `packages/core/src/usage/usage-coordinator.poll.test.ts`                   | 0.03         |
| 121  | `packages/tui/src/components/LaneList.test.tsx`                            | 0.03         |
| 122  | `packages/core/src/checkers/probe.test.ts`                                 | 0.03         |
| 124  | `packages/core/src/environment/dotnet.test.ts`                             | 0.03         |
| 125  | `packages/core/src/run/resume-context.test.ts`                             | 0.02         |
| 126  | `packages/core/src/sim/latency.test.ts`                                    | 0.02         |
| 127  | `packages/core/src/utils/claude-config.test.ts`                            | 0.02         |
| 128  | `packages/core/src/spec/index.test.ts`                                     | 0.02         |
| 129  | `packages/cli/src/cli/base-hold.test.ts`                                   | 0.02         |
| 130  | `packages/dashboard/src/useLaneEvents.test.tsx`                            | 0.02         |
| 131  | `packages/core/src/hosted/control-plane.test.ts`                           | 0.02         |
| 132  | `packages/core/src/hosted/store.sqlite.test.ts`                            | 0.02         |
| 133  | `packages/dashboard/src/attachedRepos.test.tsx`                            | 0.02         |
| 134  | `packages/core/src/daemon/repos-detach.test.ts`                            | 0.02         |
| 135  | `packages/core/src/filing/upstream-send.test.ts`                           | 0.02         |
| 136  | `packages/core/src/reports/benchmark-artifacts.test.ts`                    | 0.02         |
| 137  | `packages/core/src/usage/index.test.ts`                                    | 0.02         |
| 138  | `packages/core/src/discovery/index.test.ts`                                | 0.02         |
| 139  | `packages/core/src/daemon/runs-submit.test.ts`                             | 0.02         |
| 140  | `packages/tui/src/tabs/TabBar.test.tsx`                                    | 0.02         |
| 141  | `packages/core/src/garden/harvest.test.ts`                                 | 0.02         |
| 142  | `packages/core/src/steward/run.test.ts`                                    | 0.02         |
| 143  | `packages/dashboard/src/repoListing.test.ts`                               | 0.02         |
| 144  | `packages/core/src/daemon/registry.test.ts`                                | 0.02         |
| 145  | `packages/core/src/usage/index.defaults.test.ts`                           | 0.02         |
| 146  | `packages/core/src/config/config-schema-lint.test.ts`                      | 0.02         |
| 147  | `packages/cli/src/cli/self-update.test.ts`                                 | 0.02         |
| 148  | `packages/core/src/local-small/overnight.test.ts`                          | 0.02         |
| 149  | `packages/core/src/usage/subscription.test.ts`                             | 0.02         |
| 150  | `packages/core/src/readiness/decompose.test.ts`                            | 0.02         |
| 151  | `packages/cli/src/cli/ready-check.test.ts`                                 | 0.02         |
| 152  | `packages/core/src/hosted/docker.test.ts`                                  | 0.02         |
| 153  | `packages/core/src/checkers/baseline-cache.test.ts`                        | 0.01         |
| 154  | `packages/core/src/checkers/flaky-ledger.test.ts`                          | 0.01         |
| 155  | `packages/cli/src/agents-guide.test.ts`                                    | 0.01         |
| 156  | `packages/core/src/steering/index.test.ts`                                 | 0.01         |
| 157  | `packages/core/src/sim/jitter.test.ts`                                     | 0.01         |
| 158  | `packages/core/src/daemon/runtime-state.test.ts`                           | 0.01         |
| 159  | `packages/core/src/design/index.test.ts`                                   | 0.01         |
| 160  | `packages/repo-context/src/fs.test.ts`                                     | 0.01         |
| 161  | `packages/cli/src/cli/runs.test.ts`                                        | 0.01         |
| 162  | `packages/core/src/kpis/index.test.ts`                                     | 0.01         |
| 163  | `packages/core/src/readiness/slice-plan.test.ts`                           | 0.01         |
| 164  | `packages/core/src/readiness/slice-gate.test.ts`                           | 0.01         |
| 165  | `packages/dashboard/src/repoAttach.test.ts`                                | 0.01         |
| 166  | `packages/core/src/utils/run-lock.test.ts`                                 | 0.01         |
| 167  | `packages/core/src/router/breaker.test.ts`                                 | 0.01         |
| 168  | `packages/core/src/eval/golden.test.ts`                                    | 0.01         |
| 169  | `packages/core/src/run/lane-file-guard.test.ts`                            | 0.01         |
| 170  | `packages/core/src/usage/usage-coordinator.acquire.test.ts`                | 0.01         |
| 171  | `packages/cli/src/cli/classifier-backtest.test.ts`                         | 0.01         |
| 172  | `packages/core/src/queue/github-queue.test.ts`                             | 0.01         |
| 173  | `packages/core/src/sandbox/index.test.ts`                                  | 0.01         |
| 174  | `packages/core/src/daemon/repos-pause-resume.test.ts`                      | 0.01         |
| 175  | `packages/cli/src/cli/base-hold-clear.test.ts`                             | 0.01         |
| 176  | `packages/scbench-adapter/src/artifacts.test.ts`                           | 0.01         |
| 177  | `packages/cli/src/cli/hosted.test.ts`                                      | 0.01         |
| 178  | `packages/contracts/src/design.test.ts`                                    | 0.01         |
| 179  | `packages/core/src/hosted/runner.test.ts`                                  | 0.01         |
| 180  | `packages/core/src/hosted/store.test.ts`                                   | 0.01         |
| 181  | `packages/core/src/config/config-lint.test.ts`                             | 0.01         |
| 182  | `packages/core/src/checkers/rework-history.test.ts`                        | 0.01         |
| 183  | `packages/core/src/usage/usage-coordinator.non-claude-passthrough.test.ts` | 0.01         |
| 184  | `packages/cli/src/cli/no-em-dash.test.ts`                                  | 0.01         |
| 185  | `packages/core/src/checkers/flaky-rerun.test.ts`                           | 0.01         |
| 186  | `packages/cli/src/cli/stack-queue-merge.test.ts`                           | 0.01         |
| 187  | `packages/core/src/daemon/run-store.test.ts`                               | 0.01         |
| 188  | `packages/cli/src/cli/feedback.test.ts`                                    | 0.01         |
| 189  | `packages/scbench-adapter/src/pin-preflight.test.ts`                       | 0.01         |
| 190  | `packages/core/src/queue/approval.test.ts`                                 | 0.01         |
| 191  | `packages/cli/src/readme.test.ts`                                          | 0.01         |
| 192  | `packages/cli/src/cli/update-state.test.ts`                                | 0.01         |
| 193  | `packages/core/src/review/classifier.test.ts`                              | 0.01         |
| 194  | `packages/core/src/filing/index.test.ts`                                   | 0.01         |
| 195  | `packages/core/src/projects/project-queue-poller.test.ts`                  | 0.01         |
| 196  | `packages/core/src/review/backtest.test.ts`                                | 0.01         |
| 197  | `packages/core/src/readiness/templates.test.ts`                            | 0.01         |
| 198  | `packages/core/src/ingest/index.test.ts`                                   | 0.01         |
| 199  | `packages/core/src/phases/ship-stack.test.ts`                              | 0.01         |
| 200  | `packages/core/src/reports/evidence-pack.test.ts`                          | 0.01         |
| 201  | `packages/core/src/readiness/slice-branching.test.ts`                      | 0.01         |
| 202  | `packages/contracts/src/serde.test.ts`                                     | 0.01         |
| 203  | `packages/core/src/hosted/container.test.ts`                               | 0.01         |
| 204  | `packages/core/src/utils/ci-watch.test.ts`                                 | 0.01         |
| 205  | `packages/dashboard/src/laneBoardState.test.ts`                            | 0.01         |
| 207  | `packages/core/src/queue/project-board-poller.test.ts`                     | 0.01         |
| 208  | `packages/core/src/adr/index.test.ts`                                      | 0.01         |
| 209  | `packages/contracts/src/hosted.test.ts`                                    | 0.01         |
| 210  | `packages/core/src/discovery/promote.test.ts`                              | 0.01         |
| 211  | `packages/core/src/readiness/slice-plan-comment.test.ts`                   | 0.01         |
| 212  | `packages/core/src/reports/sandbox-ab.test.ts`                             | 0.01         |
| 213  | `packages/core/src/phases/stack-check-failure.test.ts`                     | 0.01         |
| 214  | `packages/core/src/usage/usage-coordinator.local-fallback.test.ts`         | 0.01         |
| 215  | `packages/core/src/kpis/human.test.ts`                                     | 0.01         |
| 216  | `packages/product/src/decompose/decompose.test.ts`                         | 0.01         |
| 217  | `packages/core/src/daemon/state-relocation.regression.test.ts`             | 0.01         |
| 218  | `packages/scbench-adapter/src/retry-context.test.ts`                       | 0.01         |
| 219  | `packages/core/src/review/routing.test.ts`                                 | 0.01         |
| 220  | `packages/core/src/queue/index.test.ts`                                    | 0.01         |
| 221  | `packages/adr-kit/src/index-table.test.ts`                                 | 0.01         |
| 222  | `packages/contracts/src/issue.test.ts`                                     | 0.01         |
| 223  | `packages/cli/src/cli/staleness.test.ts`                                   | 0.01         |
| 224  | `scripts/eval-history.test.ts`                                             | 0.01         |
| 225  | `packages/core/src/kpis/defects.test.ts`                                   | 0.01         |
| 226  | `packages/core/src/phases/stack-fallback.test.ts`                          | 0.01         |
| 227  | `packages/core/src/bus/index.test.ts`                                      | 0.01         |
| 228  | `packages/core/src/hosted/smoke.test.ts`                                   | 0.01         |
| 229  | `packages/cli/src/cli/filing.test.ts`                                      | 0.01         |
| 230  | `packages/core/src/utils/local-auth-record.test.ts`                        | 0.01         |
| 231  | `packages/core/src/daemon/run-repo.test.ts`                                | 0.01         |
| 232  | `packages/cli/src/cli/cost-json.test.ts`                                   | 0.01         |
| 233  | `packages/core/src/events/kinds.test.ts`                                   | 0.01         |
| 234  | `packages/repo-context/src/github.test.ts`                                 | 0.01         |
| 235  | `packages/core/src/work/local-brief.test.ts`                               | 0.01         |
| 236  | `packages/config/src/defaults.test.ts`                                     | 0.01         |
| 237  | `packages/core/src/readiness/slice-plan-github.test.ts`                    | 0.01         |
| 238  | `packages/product/src/architecture/design.test.ts`                         | 0.01         |
| 239  | `packages/product/src/interview/interview.test.ts`                         | 0.01         |
| 240  | `packages/core/src/readiness/enrich.test.ts`                               | 0.01         |
| 241  | `packages/core/src/reports/local-run.test.ts`                              | 0.01         |
| 242  | `packages/core/src/phases/stack-review-change.test.ts`                     | 0.01         |
| 243  | `packages/core/src/eval/runner.test.ts`                                    | 0.01         |
| 244  | `packages/core/src/hosted/summary.test.ts`                                 | 0.01         |
| 245  | `packages/core/src/hosted/watchdog.test.ts`                                | 0.01         |
| 246  | `packages/tui/src/dashboard.test.ts`                                       | 0.01         |
| 247  | `packages/core/src/review/containment.test.ts`                             | 0.01         |
| 248  | `packages/core/src/steward/comment.test.ts`                                | 0.01         |
| 249  | `packages/core/src/eval/score.test.ts`                                     | 0.01         |
| 250  | `packages/adr-kit/src/parse.test.ts`                                       | 0.01         |
| 251  | `packages/core/src/kpis/classifier-outcomes.test.ts`                       | 0.01         |
| 252  | `packages/core/src/discovery/author.test.ts`                               | 0.01         |
| 253  | `packages/core/src/utils/github-credentials.test.ts`                       | 0.01         |
| 254  | `packages/core/src/garden/dedup.test.ts`                                   | 0.01         |
| 255  | `packages/product/src/architecture/context.test.ts`                        | 0.00         |
| 256  | `packages/cli/src/cli/unpark.test.ts`                                      | 0.00         |
| 257  | `packages/core/src/admission/index.test.ts`                                | 0.00         |
| 258  | `packages/core/src/eval/judge.test.ts`                                     | 0.00         |
| 259  | `packages/product/src/architecture/critic.test.ts`                         | 0.00         |
| 260  | `packages/core/src/usage/subscription.profile.test.ts`                     | 0.00         |
| 261  | `packages/product/src/judge/loop.test.ts`                                  | 0.00         |
| 262  | `packages/cli/src/cli/init-files.test.ts`                                  | 0.00         |
| 263  | `packages/core/src/hosted/github-authority.test.ts`                        | 0.00         |
| 264  | `packages/core/src/work/github-issue.test.ts`                              | 0.00         |
| 265  | `packages/tui/src/tabs/run-costs.test.ts`                                  | 0.00         |
| 266  | `packages/core/src/harness/ollama-http.test.ts`                            | 0.00         |
| 267  | `packages/core/src/projects/github-project-graphql.test.ts`                | 0.00         |
| 268  | `packages/core/src/review/floor.test.ts`                                   | 0.00         |
| 269  | `packages/core/src/design/issue-192-replay.test.ts`                        | 0.00         |
| 270  | `packages/repo-context/src/contract.test.ts`                               | 0.00         |
| 271  | `packages/core/src/utils/green-prs.test.ts`                                | 0.00         |
| 272  | `packages/contracts/src/adr.test.ts`                                       | 0.00         |
| 273  | `packages/core/src/environment/orphans.test.ts`                            | 0.00         |
| 274  | `packages/core/src/utils/microvm.test.ts`                                  | 0.00         |
| 275  | `packages/core/src/work/local-only.test.ts`                                | 0.00         |
| 276  | `packages/core/src/hosted/authority.test.ts`                               | 0.00         |
| 277  | `packages/core/src/filing/policy.test.ts`                                  | 0.00         |
| 278  | `packages/contracts/src/lifecycle.test.ts`                                 | 0.00         |
| 279  | `packages/core/src/readiness/index.test.ts`                                | 0.00         |
| 280  | `packages/core/src/readiness/criteria.test.ts`                             | 0.00         |
| 281  | `packages/adr-kit/src/serialize.test.ts`                                   | 0.00         |
| 282  | `packages/tui/src/state.test.ts`                                           | 0.00         |
| 283  | `packages/scbench-adapter/src/catalog-preflight.test.ts`                   | 0.00         |
| 284  | `packages/core/src/config/template-tokens.test.ts`                         | 0.00         |
| 285  | `packages/core/src/hosted/queue-client.test.ts`                            | 0.00         |
| 286  | `packages/cli/src/cli/run-flags.test.ts`                                   | 0.00         |
| 287  | `packages/contracts/src/gherkin.test.ts`                                   | 0.00         |
| 288  | `packages/core/src/readiness/invest.test.ts`                               | 0.00         |
| 289  | `packages/cli/src/cli/queue-add-json.test.ts`                              | 0.00         |
| 290  | `packages/core/src/queue/project-board-boundary.test.ts`                   | 0.00         |
| 291  | `packages/core/src/public-api.test.ts`                                     | 0.00         |
| 292  | `packages/cli/src/cli/sweep-heartbeat.test.ts`                             | 0.00         |
| 293  | `packages/core/src/projects/project-queue-reader.test.ts`                  | 0.00         |
| 294  | `packages/core/src/work/index.test.ts`                                     | 0.00         |
| 295  | `packages/core/src/adr/relevance.test.ts`                                  | 0.00         |
| 296  | `packages/product/src/persona/panel.test.ts`                               | 0.00         |
| 297  | `packages/core/src/eval/baseline.test.ts`                                  | 0.00         |
| 298  | `packages/scbench-adapter/src/brief.test.ts`                               | 0.00         |
| 299  | `packages/repo-context/src/memory.test.ts`                                 | 0.00         |
| 300  | `packages/core/src/queue/queue-backend.test.ts`                            | 0.00         |
| 301  | `packages/core/src/filing/upstream.test.ts`                                | 0.00         |
| 302  | `packages/product/src/decompose/slices.test.ts`                            | 0.00         |
| 303  | `packages/core/src/triage/index.test.ts`                                   | 0.00         |
| 304  | `packages/core/src/queue/stale-claims.test.ts`                             | 0.00         |
| 305  | `packages/tui/src/run-tui.test.tsx`                                        | 0.00         |
| 306  | `packages/core/src/types/index.test.ts`                                    | 0.00         |
| 307  | `packages/scbench-adapter/src/compare.test.ts`                             | 0.00         |
| 308  | `packages/product/src/architecture/adrs.test.ts`                           | 0.00         |
| 309  | `packages/tui/src/fallback.test.ts`                                        | 0.00         |
| 310  | `packages/core/src/harness/codex-cleanup.test.ts`                          | 0.00         |
| 311  | `packages/cli/src/cli/help-groups.test.ts`                                 | 0.00         |
| 312  | `packages/scbench-adapter/src/suite.test.ts`                               | 0.00         |
| 313  | `packages/core/src/queue/project-board-status-writer.test.ts`              | 0.00         |
| 314  | `packages/core/src/utils/coverage-ratchet.test.ts`                         | 0.00         |
| 315  | `packages/cli/src/entry.test.ts`                                           | 0.00         |
| 316  | `packages/product/src/intent/trace.test.ts`                                | 0.00         |
| 317  | `packages/contracts/src/trace.test.ts`                                     | 0.00         |
| 318  | `packages/product/src/judge/rubric.test.ts`                                | 0.00         |
| 319  | `packages/core/src/filing/redact.test.ts`                                  | 0.00         |
| 320  | `packages/product/src/interview/coverage.test.ts`                          | 0.00         |
| 321  | `packages/core/src/sim/octokit.test.ts`                                    | 0.00         |
| 322  | `packages/cli/src/cli/hosted-queue.test.ts`                                | 0.00         |
| 323  | `packages/product/src/readiness/report.test.ts`                            | 0.00         |
| 324  | `packages/core/src/eval/trend.test.ts`                                     | 0.00         |
| 325  | `packages/product/src/export/bundle.test.ts`                               | 0.00         |
| 326  | `packages/product/src/persona/rules.test.ts`                               | 0.00         |
| 327  | `packages/core/src/reports/pr-body.test.ts`                                | 0.00         |
| 328  | `packages/core/src/hosted/orphans.test.ts`                                 | 0.00         |
| 329  | `packages/cli/src/cli/hosted-runner.test.ts`                               | 0.00         |
| 330  | `packages/core/src/review/pr-reference.test.ts`                            | 0.00         |
| 331  | `packages/core/src/queue/activity.test.ts`                                 | 0.00         |
| 332  | `packages/core/src/failure/index.test.ts`                                  | 0.00         |
| 333  | `packages/core/src/projects/project-status-writer.test.ts`                 | 0.00         |
| 334  | `packages/cli/src/cli/queue-clear.test.ts`                                 | 0.00         |
| 335  | `packages/core/src/utils/format.test.ts`                                   | 0.00         |
| 336  | `packages/dashboard/src/kpiTrend.test.ts`                                  | 0.00         |
| 337  | `packages/core/src/harness/contract.test.ts`                               | 0.00         |
| 338  | `packages/core/src/harness/classify.test.ts`                               | 0.00         |
| 339  | `packages/product/src/cli/prompter.test.ts`                                | 0.00         |
| 340  | `packages/core/src/sim/regressions.test.ts`                                | 0.00         |
| 341  | `packages/core/src/config/run-config-source.test.ts`                       | 0.00         |
| 342  | `packages/product/src/export/plan.test.ts`                                 | 0.00         |
| 343  | `packages/core/src/queue/github-queue-snapshot.test.ts`                    | 0.00         |
| 344  | `packages/cli/src/cli/readme-quickstart.test.ts`                           | 0.00         |
| 345  | `packages/core/src/hosted/runner-client.test.ts`                           | 0.00         |
| 346  | `packages/product/src/export/github.test.ts`                               | 0.00         |
| 347  | `packages/core/src/filing/sanitize.test.ts`                                | 0.00         |
| 348  | `packages/core/src/run/outcome.test.ts`                                    | 0.00         |
| 349  | `packages/product/src/export/issues.test.ts`                               | 0.00         |
| 350  | `packages/cli/src/cli/state-root.test.ts`                                  | 0.00         |
| 351  | `packages/adr-kit/src/adr.test.ts`                                         | 0.00         |
| 352  | `packages/product/src/intent/intent-doc.test.ts`                           | 0.00         |
| 353  | `packages/dashboard/src/usageHeadroomState.test.ts`                        | 0.00         |
| 354  | `packages/core/src/utils/opencode-config.test.ts`                          | 0.00         |
| 355  | `packages/adr-kit/src/numbering.test.ts`                                   | 0.00         |
| 356  | `packages/cli/src/cli/usage-json.test.ts`                                  | 0.00         |
| 357  | `packages/core/src/harness/injection-fixtures.test.ts`                     | 0.00         |
| 358  | `scripts/test-workers.test.ts`                                             | 0.00         |
| 359  | `packages/core/src/steward/detect.test.ts`                                 | 0.00         |
| 360  | `packages/core/src/router/ollama-probe.test.ts`                            | 0.00         |
| 361  | `packages/product/src/export/render.test.ts`                               | 0.00         |
| 362  | `packages/product/src/intent/statements.test.ts`                           | 0.00         |
| 363  | `packages/product/src/architecture/render.test.ts`                         | 0.00         |
| 364  | `packages/core/src/reports/ship-phase-breakdown.test.ts`                   | 0.00         |
| 365  | `packages/scbench-adapter/src/entry.test.ts`                               | 0.00         |
| 366  | `packages/cli/src/cli/status-json.test.ts`                                 | 0.00         |
| 367  | `packages/core/src/phases/board-queue-scheduler.test.ts`                   | 0.00         |
| 368  | `packages/core/src/eval/scoreboard.test.ts`                                | 0.00         |
| 369  | `packages/core/src/usage/lane-scheduler.acquire-denial.test.ts`            | 0.00         |
| 370  | `packages/core/src/phases/board-queue-dispatch.test.ts`                    | 0.00         |
| 371  | `packages/product/src/decompose/story-map.test.ts`                         | 0.00         |
| 372  | `packages/core/src/checkers/constitution-preflight.test.ts`                | 0.00         |
| 373  | `packages/dashboard/src/repoDetailState.test.ts`                           | 0.00         |
| 374  | `packages/tui/src/tabs/health-window.test.ts`                              | 0.00         |
| 375  | `packages/core/src/router/executor-error.test.ts`                          | 0.00         |
| 376  | `packages/product/src/persona/render.test.ts`                              | 0.00         |
| 377  | `packages/cli/src/node-version.test.ts`                                    | 0.00         |
| 378  | `packages/core/src/review/verdict.test.ts`                                 | 0.00         |
| 379  | `packages/core/src/utils/json.test.ts`                                     | 0.00         |
| 380  | `packages/core/src/eval/regression-report.test.ts`                         | 0.00         |
| 381  | `packages/server/src/sse.test.ts`                                          | 0.00         |
| 382  | `packages/cli/src/cli/stop-sentinel.test.ts`                               | 0.00         |
| 383  | `packages/core/src/hosted/container-provision.test.ts`                     | 0.00         |
| 384  | `packages/core/src/config/state-root.test.ts`                              | 0.00         |
| 385  | `packages/core/src/work/acceptance.test.ts`                                | 0.00         |
| 386  | `packages/product/src/index.test.ts`                                       | 0.00         |
| 387  | `packages/product/src/decompose/invest.test.ts`                            | 0.00         |
| 388  | `packages/cli/src/cli/admission.test.ts`                                   | 0.00         |
| 389  | `packages/product/src/architecture/survey.test.ts`                         | 0.00         |
| 390  | `packages/cli/src/cli/branch-prefix.test.ts`                               | 0.00         |
| 391  | `packages/product/src/entry.test.ts`                                       | 0.00         |
| 392  | `packages/core/src/phases/prompt-self-contained.test.ts`                   | 0.00         |
| 393  | `packages/core/src/router/failure-detail.test.ts`                          | 0.00         |
| 394  | `packages/core/src/harness/catalog.test.ts`                                | 0.00         |
| 395  | `packages/tui/src/tabs/log-scroll.test.ts`                                 | 0.00         |
| 396  | `packages/cli/src/cli/queue-list.test.ts`                                  | 0.00         |
| 397  | `packages/dashboard/src/theme.test.ts`                                     | 0.00         |
| 398  | `packages/core/src/readiness/size.test.ts`                                 | 0.00         |
| 399  | `packages/core/src/readiness/duplicate-guard.test.ts`                      | 0.00         |
| 400  | `packages/product/src/interview/dimensions.test.ts`                        | 0.00         |
| 401  | `packages/core/src/adr/similarity.test.ts`                                 | 0.00         |
| 402  | `packages/core/src/utils/worktree-name.test.ts`                            | 0.00         |
| 403  | `packages/core/src/harness/index.test.ts`                                  | 0.00         |
| 404  | `packages/cli/src/cli/readme-paths.test.ts`                                | 0.00         |
| 405  | `packages/product/src/adr-home.test.ts`                                    | 0.00         |
| 406  | `packages/core/src/router/stub.test.ts`                                    | 0.00         |
| 407  | `packages/core/src/ingest/file-overlap-guard.test.ts`                      | 0.00         |
| 408  | `packages/product/src/decompose/render.test.ts`                            | 0.00         |
| 409  | `packages/core/src/efficiency/fast-path.test.ts`                           | 0.00         |
| 410  | `packages/product/src/judge/render.test.ts`                                | 0.00         |
| 411  | `packages/cli/src/cli/stop-resume-json.test.ts`                            | 0.00         |
| 412  | `packages/core/src/daemon/lane-context.test.ts`                            | 0.00         |
| 413  | `packages/scbench-adapter/src/invoke.test.ts`                              | 0.00         |
| 414  | `packages/product/src/readiness/render.test.ts`                            | 0.00         |
| 415  | `packages/scbench-adapter/src/index.test.ts`                               | 0.00         |
| 416  | `packages/scbench-adapter/src/workspace-constitution.test.ts`              | 0.00         |
| 417  | `packages/product/src/persona/personas.test.ts`                            | 0.00         |
| 418  | `packages/cli/src/cli/merge-scope.test.ts`                                 | 0.00         |
| 419  | `packages/scbench-adapter/src/pin.test.ts`                                 | 0.00         |
| 420  | `packages/repo-context/src/index.test.ts`                                  | 0.00         |
| 421  | `packages/core/src/hosted/default-backend-no-container.test.ts`            | 0.00         |
| 422  | `packages/product/src/intent/render.test.ts`                               | 0.00         |
| 423  | `packages/tui/src/lane-queue.test.ts`                                      | 0.00         |
| 424  | `packages/product/src/readiness/gate.test.ts`                              | 0.00         |
| 425  | `packages/config/src/index.test.ts`                                        | 0.00         |
| 426  | `packages/product/src/interview/followup.test.ts`                          | 0.00         |
| 427  | `packages/scbench-adapter/src/leak-guard.test.ts`                          | 0.00         |
| 428  | `packages/core/src/usage/select-coordinator.test.ts`                       | 0.00         |
| 429  | `packages/product/src/interview/render.test.ts`                            | 0.00         |
| 430  | `packages/product/src/readiness/artifacts.test.ts`                         | 0.00         |
| 431  | `packages/core/src/run/policy.test.ts`                                     | 0.00         |
| 432  | `packages/scbench-adapter/src/all-groups-pass.test.ts`                     | 0.00         |
| 433  | `packages/core/src/coverage-thresholds.test.ts`                            | 0.00         |
| 434  | `packages/core/src/daemon/repo-lane.test.ts`                               | 0.00         |
| 435  | `packages/repo-context/src/path.test.ts`                                   | 0.00         |
| 436  | `packages/adr-kit/src/index.test.ts`                                       | 0.00         |
| 437  | `packages/scbench-adapter/src/checkpoint.test.ts`                          | 0.00         |
| 438  | `packages/tui/src/text.test.ts`                                            | 0.00         |
| 439  | `packages/core/src/utils/untrusted-input.test.ts`                          | 0.00         |

</details>
