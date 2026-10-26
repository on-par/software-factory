# Changelog

All notable changes to this project are documented in this file. Each PR adds its
user- or ops-visible changes under `## Unreleased`; a stable release promotes that
section to `## X.Y.Z - date`. See
[docs/ops/docs-and-changelog.md](docs/ops/docs-and-changelog.md).

## Unreleased

### Added

- `factory status` shows merged-child coverage of each decomposed parent's criteria, and a merge updates one coverage comment on the parent (#3108)
- `factory cost` takes `--since <ISO8601>` (scopes rows, perModel and total) and `--limit <n>` (caps rows only), in text and `--json` output (#3187).
- At trust tier T1 the PR classifier gate holds a deterministic sample of class-A PRs (`sha256(repo#issue)` below `classifier.t1SampleRate`, default 0.25) by applying `no-auto-merge` and logging a `t1-sampled` merge-gated event (#1958).
- The size gate gives a parent issue's acceptance criteria ids (`P1`, `P2`, ...), has each child criterion trace to them, rejects a decomposition that leaves a parent criterion uncovered (naming it), and writes `Covers parent criteria: ...` into each child body (#3105).
- A design-smell park carries its finding (approach tried, why it stinks, recommendation) on the park event payload and in the issue park comment (#1513).
- `factory draft` turns a free-text idea (`--text`, `--file` or stdin) into a factory-check-ready issue draft: one triage-tier model call (new tool-less `issue_draft` route) plus at most one repair, scored with `check --no-judge`'s readiness code. Prints Markdown or, with `--json`, one `schemaVersion` 1 object. It never files an issue, writes the queue or writes files (#3171).
- This repo commits its own `.factory/config.yaml` and a Software Factory `.factory/constitution.md`, so the GitHub Actions dogfood run has config. Only `.factory/state/` is ignored, via `.factory/.gitignore`; the root `.gitignore` no longer ignores `.factory/` (#3689).

### Changed

- BUILD prompts on the codex and opencode routes no longer inline `AGENTS.md`, which those harnesses load from the worktree themselves. A one-line pointer replaces it. claude and command routes keep the full text (#1600).
- `factory tui`'s Active tab says why it is idle (`no active work — GitHub queue empty` or `— all runs parked/finished`), and the run detail header shows issue, title, phase, elapsed time and last activity in one block (#1365).
- The agent sandbox (`sandbox-exec` and `firejail`) now denies reads of `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.config/gh`. Harness auth files stay readable (#1586).
- Claude Haiku 5.5 (`claude-haiku-5-5`, $0.10/$0.50 per Mtok) is a packaged claude-cli model. The readiness judge (`readiness_judge`) now routes through the new `triage_cheap` tier, which tries Haiku before Sonnet. `models.pins.triage` and `tiers.triage` still apply to it (#783).
- With no OS sandbox runtime on PATH, `factory doctor`'s `codex installed` line reports the Codex sandbox preflight result, the mode Codex will use (`--sandbox workspace-write`, plus any `sandbox.codexFullAccessTasks`) and how to opt in to full access (#3082).
- GitHub-queue enqueue now converges when several hosts act at once. After writing its `factory:order:<n>` label an enqueue keeps one order label per issue and moves the higher-numbered issue off a shared position, emitting an `order_collision_repaired` event (at most 3 attempts). Lane scans read every page instead of the first 100. Blocked-park auto-unpark runs only on the host named by `FACTORY_FLEET_LEADER` when it is set; unset keeps every host polling (#3147).
- `factory-run.yml` sets `FACTORY_MERGE=1` and `FACTORY_MERGE_ADMIN=1` on the `Run factory` step, so GitHub Actions runs (including dogfood) merge their green PR, with admin bypass when `FACTORY_GITHUB_TOKEN` allows it. Callers pinned to `@vX.Y.Z` get this from the next tag.
- The rendered constitution is capped at 8 KB with a `[truncated — see <file>]` marker. BUILD and rework prompts get only its Standards/Conventions/Rules/Guidelines sections, and fall back to the full text when none are found. PLAN keeps the full text (#1599).
- BUILD (commit-only, opencode, codex, local-small) inlines the frozen spec's body once, without YAML frontmatter or `adr:` drafts, and no longer points the worker at the spec file (#1595).
- The frozen spec's `route` now always matches the route that built the issue. One `RouteCapabilities` record per lane feeds both PLAN and BUILD, a single `resolveRoute` owns the codex→claude fallback, and a new `route-degraded` warn event is logged (and the spec rewritten) when the route changes after PLAN: breaker opened mid-lane, breaker gate swap, or failover inside BUILD (#664).

### Fixed

- GitHub Actions runs now merge. With `FACTORY_MERGE=1`, `factory-run.sh` runs `factory land <issue>` in the same job after `run-issue` or `ship` exits 0. Before, the `Run factory` step set `FACTORY_MERGE=1` but the job ended at a ready PR. A draft PR is not landed, CI pending still fails the job, and a failed land fails the job with land's exit code. `land` is still not an allowed `command` input (#3727).
- Two lanes sharing a breaker file no longer both run the usage-cap restore probe: a lane that claims the probe after another lane already closed or re-capped the provider drops its claim instead of probing again (#3708).
- Bare `factory logs`, `--json` and `--follow`, the `human-restarted` park check for ship/run-issue/run-brief, `factory feedback`, `factory filing preview` and `factory classifier backtest` now read rotated event-log segments, not only the live `events.ndjson` (#3711).
- SHIP CI attribution counts a CodeQL alert in a file the PR did not change as introduced by the PR when the alert is not open on the base branch, or, when base alerts can't be read, when the CodeQL check reports new alerts in code changed by the PR. Such alerts now get capped CI rework instead of a baseline ci-failed park (#3712).
- Queue preflight treats a declared prerequisite closed completed through merged child-issue PRs as met instead of parking the dependent `prerequisite #N closed unmerged` (#3703).
- `factory-run.yml` sets the git identity `Software Factory Actions <factory-actions[bot]@users.noreply.github.com>` on the caller checkout before `factory-run.sh`, so dogfood (which pins the script from tag `v0.9.18`) clears `git identity` without a new CLI release. `factory-run.sh` also sets the same identity when `user.name` or `user.email` is unset, for pinned external callers after the next tag. An existing identity in the script path is kept (#3197).
- The readiness size check counts only top-level In scope and acceptance-criteria items, so nested sub-bullets no longer inflate an atomic issue past the 5/5 hint, and `spike`-labeled issues are exempt from it (no `size_hint`, `factory check` reports runs-as-is) (#748).
- Actions dogfood: `factory-run.yml` checks out the caller repo with `FACTORY_GITHUB_TOKEN`, and `factory-run.sh` forces git's github.com auth header to that token, so pushes from `run-issue` and `ship` no longer land as `github-actions[bot]` with follow-up CI stuck at `action_required`. A `ship` that ends "left as draft (CI pending)" now exits 1 with an `::error::` instead of a green run (#3707).

## 0.9.18 - 2026-10-25

A dogfood GitHub Actions caller and a CLI pin to 0.9.18 for the reusable
`factory-run.yml` workflow, a disk guard, affected-test BUILD rounds, provider
failover across capped providers, and a `factory land` that syncs BEHIND PRs. All
seven published `@on-par` packages move to 0.9.18 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Added

- Docs and CHANGELOG process: every user- or ops-visible PR adds a `## Unreleased`
  entry and updates the README, `docs/status.md`, `docs/agents.md`, `docs/models.md`
  or `docs/ops/` in the same PR. A stable release promotes `Unreleased` to
  `## X.Y.Z - date`. The publish job refuses a `vX.Y.Z` tag, dry runs included, when
  `CHANGELOG.md` has no `## X.Y.Z` or `## [X.Y.Z]` section. Runbook:
  [docs/ops/docs-and-changelog.md](docs/ops/docs-and-changelog.md) (#3676).
- Disk guard: lanes hold new claims, and BUILD and CHECK wait, while free space on the
  worktree or state volume is under `disk.minFreeGb` (default 10). `0` or
  `FACTORY_MIN_FREE_GB=0` turns it off (#2284).
- Optional `tests.affected` command: BUILD and intermediate CHECK rework rounds run
  only the affected tests, and the full suite still runs before SHIP (#3260).
- Dogfood caller `.github/workflows/factory.yml`: a `workflow_dispatch`-only workflow
  that runs this repo's `factory-run.yml` (#3197) by relative path, with the same inputs
  and secrets. Runbook:
  [docs/runbooks/github-actions-run.md](docs/runbooks/github-actions-run.md).
- README: a GitHub Actions section that points outside callers at
  `uses: on-par/software-factory/.github/workflows/factory-run.yml@v0.9.18` and the
  runbook.
- Runbook: a Config section. `.factory/config.yaml` is optional and packaged defaults
  apply without it; commit config and constitution for real standards (only
  `.factory/state/` is ignored via `.factory/.gitignore`).

### Changed

- `factory land` syncs a BEHIND PR onto current main and merges only a CI-green synced
  head (ADR-0170) (#3654).
- `factory land` waits for a PR whose CI never started as `awaiting-ci`, re-checking
  with backoff, then parks it as `ci-never-started`. With no required checks it falls
  back to all checks on the head commit (#3208).
- A run whose claim lease is lost or has lapsed stops before push, PR or merge (#3146).
- Every `factory run` cycle releases claims whose lease has expired. When every queued
  issue waits on an open prerequisite, the cycle unqueues them and logs one
  `queue_deferred_only` event instead of idling (#3660).
- Claims no longer leave a new `factory:claim-expires:*` label behind on every claim
  and heartbeat. The heartbeat deletes the label it replaces, and the stale-claim
  reaper removes lease labels that no open issue carries (#1623).
- Provider failover: a phase that hits a usage cap reruns from its start on the next
  uncapped provider in `models.providerOrder` (#3338). When every provider is down and
  a reset time is known, the run emits one `all_providers_down` and releases the issue
  to `factory:queued` until the earliest reset (#3340). After a reset, a cheap probe
  restores the provider and emits `provider_restored` (#3339).
- When every lane-owned checker failure looks like infrastructure (timeout, network
  reset, missing tool), CHECK re-runs the checkers once with no model call, and parks
  `check-infra` if it repeats (#3371).
- The run lock is per issue and worktree, so parallel `run-brief` and `run-issue` runs
  can share one checkout (#3643).
- A loopback-bind `EPERM` in the sandbox stops `verify.sh` on the first hit and parks
  the issue as an environment error, with no rework (#3332).
- CHANGELOG: sections for 0.9.5 to 0.9.17 backfilled from the GitHub release notes;
  entries that sat under Unreleased moved to the release that shipped them (#3676).
- `factory-run.yml` installs `@on-par/factory-cli@0.9.18` (`FACTORY_CLI_VERSION`), the
  committed lockstep `package.json` versions are 0.9.18, and the runbook's external
  caller pins `@v0.9.18`. The runbook says to pin the tag of the CLI you want.
- CHECK lint runs the discovered linters and formatters and fails only on new
  findings (#1898, #3682).

### Fixed

- `factory init` no longer adds `.factory/` to `.git/info/exclude`, so
  `.factory/config.yaml` can be committed. Re-running init removes the bare `.factory/`
  line older inits added. `.factory/.gitignore` still ignores `state/` (#3689).
- A STOP during await-merge hands the issue back to the queue instead of releasing it
  as done, so the next run adopts and lands the green PR (#3291).
- Lane setup no longer fails when a `factory/<n>-*` branch already exists after a
  keep-branch close: it reuses the branch when no PR is open, else renames it aside
  (#3651).
- `factory init --detect-checks` picks `npm test` for a `package.json` repo instead of
  calling it ambiguous (#3603).
- `factory doctor` Verify rows and models-config errors name `config.yaml` on a
  `config.yaml` repo, not `.factory/config.json` (#3604).
- `decomposeOversizedIssue` no longer posts a duplicate PLAN-retry comment when the
  issue already has the decompose note (#728, #3681).
- OpenCode harness: empty output after retry, and unbounded hang, on the
  rework/`build_claude` route (#694, #3683).
- Queue refuses to reap leases when the local clock is skewed from GitHub; `factory
doctor` reports the skew (#3149, #3684).

## 0.9.17 - 2026-10-24

Review rework, provider failover that stays on subscription plans, and an optional
human checkpoint after PLAN. All seven published `@on-par` packages move to 0.9.17 in
lockstep. Install or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- Review rework: a queued review rework runs BUILD rework on the same PR branch with
  only that review's comments, then re-runs CHECK. Runs are capped per issue (default
  2), and the issue parks with one comment naming the cap (#3564, #3565).
- A `/factory iterate` PR comment reruns rework on the same branch (#3625).
- Optional human checkpoint: issues labelled `factory:needs-design` pause after PLAN
  (#3621).
- A per-lane agent memory file is fed into PLAN prompts and updated through a PR
  (#3624).
- PLAN output has a vertical-slice outline with per-phase files and automated and
  manual checks (#3622).
- The evidence pack gets a walkthrough for large PRs (300 or more lines, or 5 or more
  files) (#3623).
- `factory check` prints the readiness verdict with its questions or assumptions, and
  exits 1 only when the ticket is `not-ready` (#3469). A `readiness` eval suite tracks
  the judge (#3468).
- `factory usage --json` reports the plan (subscription, api or unknown) detected from
  Claude Code auth (#3214). `factory status --json` adds `providers[]` (plan, breaker
  state) and `activeAlerts[]`, and a `provider_restored` event fires when a breaker
  closes (#3236).
- A recurring sweep closes factory draft PRs older than 24 hours with no active claim
  and requeues their issues (#3552).

### Changed

- Provider failover: a capped or failing provider fails over to the next configured
  provider for the stage, and the issue goes back to `factory:queued` only when every
  provider for the stage is blocked (#3226). With no known reset time, the run parks
  `all_providers_down` instead of spinning (#3235).
- Automatic failover never moves onto a metered (API-key or unknown-plan) provider.
  Claude or Codex in `models.providerOrder` signed in with an API key is refused and
  logged once as `provider_refused`. OpenCode Go runs only `opencode-go/` models
  (#3234, #3335).
- `failover.triggers` decides which non-cap failures fall back to another model at the
  same provider, and a usage cap ends the call. The unread
  `escalateAfterTierExhausted` key is removed (#3228). Codex usage limits are
  classified as `usage_cap` with the reset time (#3227).
- `factory unpark` queues at the back of the lane. `--keep-order` keeps the old order
  (#3554).
- Before merge, a PR whose base is stale is rebased and its checks re-run on current
  main, or the merge is refused (#3619). A base hold waits for green CI on the new main
  SHA, not only a SHA change (#3620).
- `events.ndjson` rotates by size (#1631).

## 0.9.16 - 2026-10-23

Review rework intake, baseline cache expiry, and config snapshots for one-shot runs.
All seven published `@on-par` packages move to 0.9.16 in lockstep. Install or update
with `npm install -g @on-par/factory-cli@latest`.

### Added

- A trusted "changes requested" review on a factory PR queues its issue for review
  rework, once per review id (#3563).
- `factory status` and `factory kpis` show the count of open factory draft PRs (#3553).
- `pr.footer` sets the PR body footer: a non-empty string replaces it, `""` removes it
  (#3602).

### Changed

- Baseline cache entries expire, are re-checked when GitHub CI disagrees, and can be
  cleared (#3540).

### Fixed

- One-shot runs (`ship`, `run-issue`, `run-brief`, `run` lanes) snapshot the source
  checkout's `.factory/config.*` for the whole run, as the daemon does. CHECK now runs
  the declared `checks.build`, `checks.test` and `checks.lint` when `.factory/` is
  untracked and so missing from the worktree. SKIP details name the file and directory
  probed, and `factory doctor` warns when `.factory/` is git-ignored or excluded
  (#3600).

## 0.9.15 - 2026-10-23

Repo-declared check commands and honest SKIPs in CHECK. All seven published `@on-par`
packages move to 0.9.15 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Added

- Repos can declare their build, test and lint commands under `checks`, and
  `factory init --detect-checks` fills them in (#3594).
- A rejected or revoked credential fails over, holds that provider's breaker open
  until the credentials change or `factory breaker reset`, and emits one
  `provider_auth_rejected` event (#3232).

### Changed

- A compile, tests or lint checker that finds no command reports SKIP, not PASS. The
  summary never says "All checkers passed" when nothing was built or tested (#3566).
- A same-file lane hold parks the issue as `held` (needs a human) instead of
  deferring it (#3576).
- Queue preflight and `factory land` adopt a DIRTY or still-UNKNOWN open PR: land
  merges origin/main into it with a plain push and re-runs CI (#3324).
- The readiness judge returns a strict-JSON verdict on its own `readiness_judge`
  route, cached per issue-body hash (#3467).

## 0.9.14 - 2026-10-22

Provider breakers, worktree keep and release, and a long list of queue, land and CI
rework fixes. All seven published `@on-par` packages move to 0.9.14 in lockstep.
Install or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- `models.providerOrder` lists the subscription providers in failover order per role.
  OpenCode Zen models are refused there and as failover targets (#3334).
- A provider-agnostic error classifier feeds the breaker, with adapters for Claude's
  5-hour and weekly limits and OpenCode Go. A usage cap marks the provider capped
  until its reported reset, or re-probes after 1 hour, and emits one
  `provider_capped` event. The usage watchdog reads Claude's weekly window too
  (#3225, #3229, #3336, #3337).
- `factory worktree keep` and `factory worktree release` for manual work. A worktree
  is released on unpark or re-queue (#3318).
- `sandbox.writablePaths` adds directories the sandbox can write. A .NET worktree can
  write `~/.nuget` and `~/.dotnet` with no config (#3454, #3567).
- An `app_smoke` checker starts the built app on the lane port and runs the repo's
  smoke command (#3253).
- `factory doctor` shows the build, test and lint commands CHECK will run, where each
  came from, and whether each executable is on PATH (#3473). Doctor and run start warn
  about config keys the installed version does not know (#3568).
- `factory status` shows the build route the run will use (#3437).
- `factory daemon status --json` works on Linux and reports load (#3201).
- `build.contextCeiling` per harness (default `{ "codex-cli": 120000 }`) (#3327).
- An opt-in notify command fires on park and drain (#3512). `factory kpis` reports the
  open parked count and the median park-to-human time (#3513).
- `factory cost --json` adds cache token sums (#3212).
- `queue.claim_settle_ms` sets the claim settle delay (#3239).
- A factory command can run on a GitHub-hosted runner through `workflow_dispatch`, with
  a provider input (#3197, #3199).
- A repo with no `scripts/verify.sh` runs `scripts/verify.ps1` through `pwsh` (#3471).

### Changed

- A parked or failed run closes its draft PR with the park reason and keeps the
  branch (#3551).
- CI rework: an attributable non-CodeQL failure syncs main and runs capped BUILD
  rework on the failing job's log before it parks, and CodeQL alerts on the PR merge
  ref reach CI rework (#3537).
- SHIP reads the CI watch deadline from config and reports a timeout with checks still
  running as "CI pending" (#3569). A park comment says why SHIP failed (#3440).
- BUILD installs the lane worktree's JS dependencies with a frozen lockfile install
  first (#3370).
- Queue preflight re-reads an UNKNOWN merge state up to 3 times, then defers. An issue
  that a merged PR already closes parks before PLAN. `- Prerequisite: #N` bullets
  count as prerequisites (#3323, #3333, #3375).
- ADR readiness is a model-judged verdict (`ready`, `ready-with-assumptions`,
  `not-ready`), and PLAN never rewrites the ticket (#3457).
- The design critic skips docs-only and tests-only diffs (#3374).
- `factory migrate` reads YAML configs (#3436), and the auto-merge setting resolves the
  same way in the app and the engine (#3438).
- The legacy `ollama-command-agent` path is retired in favour of the `ollama-agentic`
  harness (#3445).
- README Quick start is short and provider-agnostic, provider setup lives in
  `docs/agents.md`, and the macOS LaunchAgent and keychain setup is an optional recipe
  (#1568). `CONTEXT.md` defines the domain terms (#3446).

### Fixed

- A heartbeat or claim that fails halfway never leaves a claimed issue without a lease
  (#3434). `release()` removes only its own `claimed-by` label, and the stale-claim
  reaper re-reads before it removes (#3240). One claim-liveness verdict is shared by
  the reaper, worktree GC and the lane-file guard (#3442).
- A decomposed issue's children are queued before the lane moves on (#3539).
- `factory land` syncs a conflicting (DIRTY) PR before it watches CI, and a land-time
  park updates the issue's park comment (#3533, #3534). PR lookup by issue checks the
  head repo and reports ambiguous matches (#3439).
- CHECK enforces the coverage thresholds, so a PR under CI's per-package threshold no
  longer passes CHECK and parks as `ci-failed` (#3536).
- Every run logs exactly one terminal event, and a CI re-CHECK parks with the same
  reasons as the first CHECK (#3435). A CI-failed park with a running heartbeat ends
  with the lane label plus `factory:parked` (#3427).
- `factory doctor` fails an empty or comment-only `.factory/config.yaml`, as the other
  commands already did (#3345).
- `factory status` no longer reads "idle" while a GitHub-label-queue lane is mid-run
  (#3344).
- `factory steer <url>` uses the URL's owner and repo (#3421).
- Every worktree removal goes through one GC decision (#3441, #3443).

## 0.9.13 - 2026-10-21

`--draft-pr` stops SHIP at a draft PR, and macOS sandbox lanes enforce the egress
allowlist. All seven published `@on-par` packages move to 0.9.13 in lockstep. Install
or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- `--draft-pr` and `--no-draft-pr` on `factory ship`, `factory run-issue` and
  `factory run-brief`, with a repo default `run.pr.draft`. With draft on, SHIP opens
  the draft PR, waits for CI and runs CI rework as usual, then skips mark-ready and
  auto-merge. The run ends `ready` with the PR left as a draft (#3449).
- macOS sandbox lanes enforce the egress allowlist through the lane proxy (#2215).

### Changed

- scbench (private adapter): the workspace constitution sets `requireTests: true`,
  adds cross-checkpoint stability, spec-exact I/O and a hidden-test leak guard, and
  `compare` shows per-group pass-rate deltas (#1202, #1204, #1207).

### Fixed

- Reconcile and doctor flag lane-labelled issues that carry no state label (#3426).
- A failed `factory:parked` add is surfaced as a `fail` event naming the issue and
  label (#3425).
- `adapter-smoke` fails when the agent shim is missing from PATH (#2681).

## 0.9.12 - 2026-10-21

Claim-label race fixes for factory lanes. All seven published `@on-par` packages move
to 0.9.12 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Fixed

- A queue heartbeat re-reads the issue's labels before it writes a lease, and skips
  the write when the issue is no longer in progress or claimed by this host. Before, a
  heartbeat after release could put `factory:claim-expires:*` back on a released issue
  (#3422).
- The lane stops the issue's heartbeat timer and awaits any in-flight tick before
  every release, so a tick can't write labels while release removes them (#3423).
- Releasing as parked adds `factory:parked` first (retrying once), then removes the
  in-progress, order, claimed-by and claim-expires labels. Before, a crash between the
  removes and the add left an issue that nothing would queue, park or reap (#3424).

## 0.9.11 - 2026-10-21

Risk policy, steering events, `--no-pr`, one-slice-per-run stack mode, spend caps
inside BUILD, and a stricter CHECK. All seven published `@on-par` packages move to
0.9.11 in lockstep. Install or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- Risk policy: a deterministic risk evaluator, a risk receipt on each PR, risk in
  `factory land` output and `factory doctor`, a `factory risk` command, and enforcement
  at land (labels, held high-risk PRs, a notification). The policy is an optional
  `risk:` section of `.factory/config.yaml` (#3380, #3381, #3385, #3386, #3387, #3418).
- Steering: a steer event schema and append-only store, a `factory steer` command, and
  a `steers_per_merged_pr` report by lane and week (#3400, #3401, #3403, #3404).
- `ship`, `run-issue` and `run-brief` take `--no-pr`. The run does PLAN, BUILD and
  CHECK in a normal factory worktree, then stops. It skips SHIP and writes nothing to
  GitHub: no push, PR, park comment, issue-body enrichment, flaky-test issue, or
  size-gate child issue (the size gate is off). The worktree and branch are kept,
  protected from GC by a keep record (#3357).
- Each run's PLAN and BUILD worker output is kept, redacted and capped, under
  `.factory/state/logs/issue-N/run-<runId>/`, with the last 5 runs per issue retained
  (#3274).
- CLI JSON contract: the read-only and write-action `--json` commands have zod
  definitions and committed JSON Schemas, shipped in the npm package under `schemas/`.
  CI fails a PR that removes, renames or retypes a field without bumping
  `schemaVersion`, and release notes list contract changes. New schemas: `cost`,
  `daemon-status`, `logs-line`, `queue-add`, `queue-list`, `resume`, `runs`,
  `runs-diffstat`, `status`, `stop`, `unpark`, `usage` (#3175, #3176, #3177, #3178,
  #3181, #3182).
- `factory logs --json --since <cursor> --limit N` reads only the tail of
  `events.ndjson` (#3174).
- CHECK runs the plan's evidence entries: each non-app `evidencePlan` command runs
  under the sandbox and allowlist after the other checkers are green, and a FAIL goes
  to rework naming the acceptance criterion. `expect.stdoutContains` must match,
  fail-to-pass entries must fail on base and pass on head, and leftover files or
  processes fail `side_effects` (#3256, #3257, #3258, #3259, #3263, #3264).
- `timeouts.compile_seconds` or `FACTORY_COMPILE_TIMEOUT` sets the compile checker
  timeout, which was a fixed 120 s (#3185).
- A claim-time preflight defers a queued issue whose declared prerequisite has not
  merged, before any PLAN call (#3267).
- `factory land` merges origin/main and auto-resolves the ADR index (#1886).

### Changed

- Cost control: BUILD stops mid-session once spend crosses the per-issue cap and parks
  with actual vs cap. Codex reports running token usage. Terminal events carry the
  plan and build model, provider and effort. Cached input is priced at a per-model
  cached rate. Every phase and harness writes a cost row, and Codex rows add model-call
  count, peak context and per-call cost (#3126, #3280, #3284, #3319, #3320, #3321).
- Codex agentic BUILD and rework sessions get a 120K auto-compact limit and a handoff
  prompt (#3326).
- Codex fails closed to `workspace-write`; full access needs a per-task config opt-in.
  `FACTORY_SANDBOX_RUNTIME=none` keeps Codex's own sandbox (#3233, #3247).
- Codex PLAN can write its spec under the resolved factory state directory, and
  worktree commits can update the primary repo's `.git` metadata. Codex grants GitHub
  egress to PLAN and publishing build tasks, keeps the configured allowlist for other
  agentic build tasks, and runs judges and classifiers without network access (#3249).
- Stack mode builds one slice per run and resumes at the next pending slice. Slice k's
  PR opens on slice k-1's branch and names the stack order. The queue can claim the
  next slice once the top slice PR is approved or merged, and after a lower slice is
  squash-merged the open slice PRs above it are rebased onto main (#3348, #3366,
  #3367, #3368).
- The size gate splits only when the plan's token estimate or changed-file count is
  over budget. The slicer keeps an issue whole when its slices mostly edit the same
  files, and the planner gets the size-gate verdict (#3275, #3350, #3351).
- CHECK runs checker commands with an empty global and system git config, and marks
  the build's untracked files intent-to-add first (#3271, #3272).
- Base health: only code-health checks (`baseHealth.checks`) decide whether the base is
  green. A green GitHub CI result overrides a local compile timeout, and a cached FAIL
  is re-checked once after CI goes green instead of looping (#3186, #3195, #3287,
  #3290, #3288).
- A keep record protects a parked issue's worktree until the issue closes, and a budget
  park writes one (#3316). Requeuing a `ci-failed` issue reuses its draft PR and branch
  (#2253).
- BUILD and rework prompts tell the worker to read the code it will change first, and a
  re-dispatched issue gets a short `## Previous attempt` note (#3372, #3373). A no-diff
  park records the worker's last output and a cause (#3273).
- PLAN parks `config` when the spec write is denied, and parks an invalid plan instead
  of spending a BUILD when the design artifact stays invalid (#3269, #3270).
- `factory harness check` proves an agentic harness commits in a scratch worktree
  (#2876).

### Fixed

- factoryd's LaunchAgent finds nvm's Node, so automatic self-update no longer fails
  with "npm not runnable" (#3122).
- factoryd accepts repos set up with `config.yaml` (#3092). Re-attaching a registered
  repo is a no-op: it does not resume a paused repo or reset `attachedAt` (#3200).
- `factory runs --json` shows status, branch and lane (#3194).
- `factory queue list` skips an issue with a bad `factory:order` label and reports it
  in `orderConflicts`, and a queued release always carries an order label (#3192,
  #3193).
- SHIP waits for a PR with no CI checks reported yet instead of skipping the wait and
  parking a PR that goes green (#3206).
- `factory supervise` no longer clears a manual STOP every cycle (#3209).
- The lane-file guard reaps a file claim left by a crashed run (#1618).
- SHIP skips the leftover-output commit when nothing is staged (#3262).

## 0.9.10 - 2026-10-17

Stops the end-of-run KPI sweep from exhausting the GitHub REST rate limit. All seven
published `@on-par` packages move to 0.9.10 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Fixed

- The end-of-run KPI snapshot no longer exhausts the GitHub REST rate limit. It used
  to make about 800 calls per run. Now runs that open no PR and merge nothing skip the
  sweep. A sweep reads `GET /rate_limit` first and skips, marking the snapshot partial,
  when less than 20% of the core budget is left. The sweep keeps a cursor and per-PR
  cache in `kpi-sweep-cache.json` in the state dir, sends a conditional (ETag) list
  request and fetches details only for PRs that changed, batched in GraphQL. Merged
  PRs are never fetched again. A steady-state run makes 1 REST call, usually a free
  304 (#3166, #3167, #3168, #3169).
- Queue label setup no longer POSTs `createLabel` for labels that already exist. The
  repo's label list is read once per client, and the 422 `already_exists` handling
  stays as a fallback for races.

## 0.9.9 - 2026-10-17

Queue, claim and ship fixes, and an explicit opt-in for Codex full access. All seven
published `@on-par` packages move to 0.9.9 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Changed

- Codex `danger-full-access` needs an explicit operator opt-in (#3080).
- `factory ship` on an issue that already has an open factory PR continues on that
  branch or refuses before PLAN (#3099).
- The host build cap applies together with `run.maxConcurrency` (#3049).

### Fixed

- Claims are released on `factory land` and auto-merge, and failed release writes are
  logged (#3067).
- The base health check uses the configured tests timeout instead of always 300 s
  (#3095).
- `factory queue list` and `factory status` report duplicate order positions, and
  duplicates are claimed by issue number. `queue add` rejects empty lane names and
  stops long names merging lanes (#3100, #3101).
- BUILD runs on a declared agentic harness through the commit-only command route, and
  CHECK rework stays on that harness (#3064, #3066).
- Octokit no longer logs a request line for every 4xx response (#1004).
- Test runs no longer leak temp dirs into the macOS `TMPDIR` (#3114).
- README and `docs/agents.md` corrections: Quick start covers Claude Code, triage does
  not always run `claude -p`, and the no-CI wait is about 112 s (#3096, #3097, #3098).

## 0.9.8 - 2026-10-16

The Pi harness, OpenCode hardening, host build slots, and a cleaner `factory doctor`.
All seven published `@on-par` packages move to 0.9.8 in lockstep. Install or update
with `npm install -g @on-par/factory-cli@latest`.

### Added

- Pi harness (experimental): PLAN and CHECK with token usage and cost, failure
  classification from the JSON event stream, effort as `--thinking`, BUILD through
  the commit-only route, and the Pi version and `pi auth check` in `factory doctor`.
  Pin-only DeepSeek models on Pi through OpenRouter (#2900, #2901, #2902, #2903, #2904,
  #2905, #2909, #2910).
- `factory harness check <id>` runs the contract kit on a declared harness (#2875).
- Host build slots cap concurrent BUILD and CHECK phases across runners. Slots left by
  crashed lanes are reclaimed, `factory status` shows slots in use, rescue and steward
  jobs hold a host agent job lease, and new claims wait while the host load average is
  high (#3043, #3044, #3045, #3047, #3048).
- A claude-cli model can use its own approved intermediary endpoint and credentials,
  priced from registry prices. Doctor warns when an intermediary's ZDR review date has
  passed. An experimental pin-only DeepSeek V4.1 Flash runs on Claude Code through
  OpenRouter (#2897, #2906, #2907, #2908).
- `factory init --yes` for non-interactive setup (#2546).
- `factory doctor --probe-inference` probes OpenCode auth live (#2892).
- SHIP pushes and verifies local rework commits on an existing PR, fails closed when
  the branch diverged or the push is rejected, and names the checked commit SHA in the
  evidence pack (#1812, #1813, #1815).
- Stack mode builds a chain of slice branches in one run, enforces `maxSlices` even
  when the gate is bypassed, and stops at a slice that fails CHECK (#3058, #3059,
  #3060, #3061).
- The BUILD prompt summarises the target repo's lint config (oxlint, ESLint, Biome)
  (#3039, #3040, #3041, #3042).

### Changed

- OpenCode: effort is passed as `--model provider/model#effort` on v2 (`--variant` on
  v1), runs pass `--standalone` on v2, only the final assistant message is returned,
  errors are classified by `error.type`, and BUILD fails over to another harness when
  OpenCode is capped or its breaker is open. Doctor flags an unsupported OpenCode
  version, and a failed login is reported with re-auth steps (#2878, #2879, #2881,
  #2883, #2885, #2886, #2887, #2889, #2890, #2891, #2880).
- The OpenCode Go DeepSeek model moves to V4.1 Flash, with a pin-only V4 Pro.
  Training-eligible models stay out of automatic tiers. Direct DeepSeek endpoints, keys
  and providers are refused at config load, and the broken `deepseek-v3` model is
  removed (#2894, #2895, #2898, #2899).
- `factory doctor`: each agent in one row, missing agents shown as optional when
  another is ready, the summary names the ready agents, the macOS keychain row is
  hidden on Linux, model reachability says "not checked" with how to run it, and
  SSH origins get SSH-specific git-auth guidance. claude-cli models with a
  non-Anthropic provider are reported as unsupported (#2723, #2896, #2939, #2940,
  #2996, #2997, #2998, #2999, #3000).
- Triage drops issues linked to an open factory branch PR and lists skipped issues in
  `queue.proposed` (#2981, #2982, #2983).
- `factory status` shows when STOP is set and how to clear it (#2544).
- Messages and model-override log lines name the loaded repo config file (#2497,
  #2570).
- SHIP skips the CI wait sooner when a repo has no CI (#2488).
- A PR-less ship removes a clean worktree and branch, and keeps and explains one that
  holds work (#3008, #3009).
- `self-update --to` names the failing doctor checks in its rollback error and records
  its outcome in `lastResult` (#2932, #2933).
- Factory allowed hosts map into the Codex workspace-write network config (#3079).
- Stale claims are reaped at the file-collision check, at run startup and at queue
  reconcile (#3063, #3065).

### Fixed

- `factory daemon start` no longer leaves factoryd unloaded (launchctl EIO) when it is
  already running (#2922).
- In a two-lane run, one lane's worktree sweep no longer deletes the other lane's fresh
  worktree (#2964).
- The breaker parses absolute "resets at <ISO time>" hints and waits for the real
  reset (#2884).
- An exit-0 OpenCode run with no final `step_finish` is retryable, and an auto-rejected
  permission fails as non-retryable, naming the tool (#2882, #2888).
- Queue: a duplicate `factory:order` in a lane is skipped instead of stalling the
  lane, order selection scans every open in-lane issue, and enqueue or unpark reports
  conflicting issues (#2977, #2987, #2988, #3014, #3015).
- The scaffold template has no live placeholders, so an unedited scaffold passes the
  preflight config check (#2973, #2974, #2975, #2976).
- `factory models` hides the raw "ollama: not found" shell error (#2724).

## 0.9.7 - 2026-10-14

Bring-your-own-agent harnesses, CI-failure rework in SHIP, and blocked-issue parking.
All seven published `@on-par` packages move to 0.9.7 in lockstep. Install or update
with `npm install -g @on-par/factory-cli@latest`.

### Added

- `.factory/config.yaml` can declare harnesses and pin a model to one. Doctor sees
  them, BUILD runs on a pinned agentic harness through a commit-only command route,
  CHECK rework stays on it, and PLAN or repo config can choose `route: command`. A
  non-agentic harness pinned for BUILD is refused at config load (#2869, #2870,
  #2871, #2872, #2873, #2874). `docs/agents.md` is now a "Bring your own agent"
  walkthrough (#2877).
- SHIP handles CI failures: it parks CI-watch failures as `ci-failed` with an evidence
  summary, sends attributable failures through capped BUILD rework and re-watches the
  new head, parks non-attributable ones as `ci-failed` baseline, and parks rework that
  tries to suppress findings (#2814, #2815, #2816, #2817, #2818).
- A `blocked` park reason. The factory files blocker child issues through GitHub issue
  dependencies and unparks the issue when its blockers resolve (#2315, #2316, #2318).

### Changed

- The planner is re-prompted with the validation errors when the design artifact is
  invalid, and the run says what it loses when it stays invalid (#2803, #2804).
- The BUILD prompt tells the worker to run lint and tsc when the repo has them, and
  keeps `verify.sh` primary (#2828, #2829, #2830).
- The park comment on an issue is one comment, updated in place (#2314).
- The TUI runs on Ink 8 (#2810, #2811).

### Fixed

- Lane worktree names no longer repeat `factory` segments (#2763).
- Issue-number arguments reject unsafe integers (#2836).

## 0.9.6 - 2026-10-14

Adds `factory self-update --to`. All seven published `@on-par` packages move to 0.9.6
in lockstep. Install or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- `factory self-update --to <version>` installs an exact stable version next to the
  running Node, runs `factory doctor`, restarts factoryd, and rolls back on failure.
  factoryd runs a preflight before it drains for an update (#2355).

### Fixed

- Object-shaped `edgeInputs` entries in the design artifact are coerced instead of
  rejected (#2802).

## 0.9.5 - 2026-10-14

Config validation before PLAN, size-gate stack mode, agent-neutral runs, and OIDC npm
publishing. All seven published `@on-par` packages move to 0.9.5 in lockstep. Install
or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- Preflight and `factory doctor` check the constitution and config before PLAN:
  unknown checker names, unfilled template tokens, placeholder checkers (with
  file:line and a fix) and schema errors. Both use one rule set (#2585, #2586, #2610,
  #2611, #2612).
- A config failure has its own `config` cause: CHECK classifies it, the issue parks
  with an actionable message, and the event kind, park reason and `factory status`
  show it (#2581, #2582, #2583, #2584, #2587).
- Size-gate stack mode (ADR-0161): an oversized issue can ship as a native GitHub
  stacked PR set, selected by config or a CLI flag. Too-big results route to slicing,
  the slice-plan comment records each slice's branch and PR, and the stack parks at a
  slice that fails CHECK or when review changes a lower slice. It falls back to slice
  mode when the stack API fails (#2619, #2660, #2662, #2663, #2665, #2668, #2670,
  #2671, #2672, #2673, #2674, #2675).
- Egress defaults per ecosystem: npm and yarn registries for Node repos, NuGet hosts
  for .NET repos. Telemetry hosts are classified separately in the egress summary, and
  a config switch blocks them (#2659, #2661, #2664, #2667, #2669).
- `factory doctor` shows an auth check for each installed agent CLI and fails an agent
  whose last run hit `local_auth` with no login since. An expired Claude login with no
  refresh token fails doctor (#2631, #2721, #2733).
- An agent-support issue form, linked from `docs/agents.md` (#2698, #2699).
- `FACTORY_GITHUB=stub` runs `factory ship` against an offline GitHub stub (#2652).
- Every merge to `main` that passes CI publishes an `X.Y.Z-next.N` prerelease to the
  `next` dist-tag (#2762, #2772).

### Changed

- npm publishing uses OIDC trusted publishing with provenance instead of the
  `NPM_TOKEN` classic token, and fails early on npm older than 11.5.1. Setup,
  verification and troubleshooting are in
  [docs/runbooks/npm-trusted-publishing.md](docs/runbooks/npm-trusted-publishing.md)
  (#2627, #2628, #2630).
- Agent-neutral runs: the router skips models whose CLI is missing, the steward model
  comes from the boss tier instead of a Claude pin, PLAN and CHECK rework fall back to
  a runnable route, and Codex-only and OpenCode-only runs complete the full loop. The
  usage watchdog says when it is not available for the agent, and a repo-pinned command
  harness counts as a coding agent (#2629, #2632, #2633, #2634, #2635, #2691).
- The `default-code` constitution runs only its declared checkers (#2455).
- `npm install` warns on Node below 24. The guard message pins the running CLI version
  in the reinstall line and offers nvm only when nvm is present (#2470, #2599, #2600).

### Fixed

- `gh` auth failures print `gh auth login` guidance, a rejected `GH_TOKEN` names the
  repo scope, and non-github.com remotes keep the no-GitHub-remote wording (#2592,
  #2593, #2594).
- `factory resume --from check` keeps the build output after a non-code CHECK failure
  (#2564).
- The baseline cache never stores config or validation errors as base results
  (#2563).
- `factory --help` shows the right proposed-queue path, and doctor does not suggest
  `models --doctor` outside a repo (#2472, #2603).

## 0.9.4 - 2026-10-12

Fixes the pre-PLAN base health check that read a green `main` as red in JS
repos, plus a `factory doctor` overhaul for first-run setup and broader
agent-neutral support. All seven published `@on-par` packages move to 0.9.4 in
lockstep. Install or update with `npm install -g @on-par/factory-cli@latest`.

### Added

- `factory doctor` walks a fresh install through setup: one section per
  harness with install checks, a sign-in check that makes no model call, git
  authentication to origin, and repo checks that print the next command
  (`factory init`, `gh auth login`, git identity). It runs outside a git repo
  and skips repo checks there (#2483, #2484, #2550, #2551, #2554, #2555,
  #2556, #2557).
- `factory --help` and the `factory init` Next hint name `factory doctor` as
  the first step (#2506, #2558).
- Any coding agent CLI satisfies the ship, run and doctor prerequisites, and
  the router only routes to agents that can run on this host (#1269, #2406).
- OpenCode: prompts go via stdin or a file, JSON output is parsed for the final
  message and token usage, failures are classified, and auth is probed as a
  CLI with an optional API key override (#2460, #2461, #2462, #2463).
- `docs/agents.md`: harness matrix, provider sections, config recipes and an
  add-your-own-agent section, linked from both READMEs (#2532, #2533, #2539,
  #2540, #2541).
- `factory models` and `factory doctor` mark repo-defined models and report
  invalid `models.registry` entries (#2442, #2443).

### Changed

- `factory triage` runs through the model router (#1650).
- A pinned build model fails over only on `usage_cap` or `rate_limit`, and the
  ready summary and PR evidence say when a build pin was overridden (#2510,
  #2511).
- A required check that cannot run fails CHECK instead of passing silently
  (#2493).
- A signed-out agent CLI trips a per-run breaker. A Codex 401 is reported as
  `local_auth` with a one-line `codex login` hint (#2494, #2495).

### Fixed

- The base worktree used by pre-PLAN base health and the CHECK baseline
  installs JS dependencies before running checkers. Without them `compile`
  failed with `tsc: command not found`, every issue was released to queued as
  `environment`, and the failure was cached (#2576).
- `factory doctor` checks `.factory/state/STOP`, not `.factory/STOP` (#2453).
- An expired Codex access token with a refresh token counts as signed in, and
  an expired ChatGPT session does not (#2509, #2516).
- `factory ship` and `factory run-issue` refuse a pull request number (#2492).
- `factory triage accept` accepts the queue `factory triage` just wrote
  (#2450).
- `factory init` hides the raw "ollama not found" shell error (#2507).

## 0.9.3 - 2026-10-12

First-run reliability fixes and the start of agent-neutral command harnesses.
All seven published `@on-par` packages move to 0.9.3 in lockstep. Install or
update with `npm install -g @on-par/factory-cli@latest`.

### Added

- Command harnesses: you can declare your own harness ids in config, and the
  factory runs a configured command harness with safe placeholder
  substitution inside the sandbox policy. Failures and usage are classified
  through the contract kit, and the adapter contract is documented (#2428,
  #2429, #2430, #2431, #2432).
- `factory doctor` and `factory models --doctor` probe configured command
  harnesses (#2433).
- Repos can declare models in `models.registry`; they are loaded and pinned,
  and redefining a packaged model id has defined, tested behaviour (#2440,
  #2441).
- A default code constitution and checker list. Runs use the repo's
  `.factory/constitution.md` (#2387).

### Changed

- Claude and Codex models count as reachable only with login evidence.
  Models with no auth evidence are reported as unverified, and `factory init`
  agrees with `factory doctor` (#2417, #2418, #2419).
- `factory models` agrees with `factory models --doctor` on provider
  availability (#2402).
- README first-run accuracy sweep: state paths, worktrees, the constitution
  flow and the new checks (#2389).
- `factory ship` logs a normal PR open as `pr_opened`, not recovered, and the
  remaining naming now says On PAR Dev's Software Factory (#2388).

### Fixed

- Lane worktree runs resolve the constitution from the main checkout and
  ignore constitutions authored in a worktree. An integration test proves an
  edited constitution reaches a lane run (#2411, #2412, #2413).

## 0.9.2 - 2026-10-11

Public-repo cleanup and first-run reliability fixes. All seven published
`@on-par` packages move to 0.9.2 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Changed

- `factory feedback` files its issue in your own repo: `--repo owner/name`,
  then the new `filing.repo` config key, then the checkout's `origin` remote.
  It no longer falls back to on-par/software-factory; with no repo it stops
  with a clear error. The issue leaves out your host name and local design and
  log paths unless you pass `--include-local-paths` (#2398).
- Upstream factory reports have no built-in target repo either. Without an
  explicit repo they are skipped with reason `no-target-repo` (#2398).
- Public-repo cleanup: removed internal operations notes and research from
  the docs and fixed broken doc links (#2398).
- The CLI refuses to start on Node below 24 with a clear message, before it
  loads `node:sqlite` (#2390).
- `factory doctor` runs outside a repo, checks your git identity, and warns
  when no sandbox runtime is available (#2391).
- Readiness keeps the original issue body when enriching it and adds an
  opt-out (#2395).

### Added

- factoryd checks for updates every 30 minutes, drains, self-updates and
  restarts via launchd, and skips versions that failed (#2375).

### Fixed

- The model router skips Ollama models when Ollama is unreachable, and triage
  logs the model it actually runs (#2394).
- `factory ship` detects a repo with no CI checks early and logs CI wait
  progress (#2396).

## 0.9.1 - 2026-10-11

Docs and metadata refresh for the npm page, plus the factory changes merged
since 0.9.0. All seven published `@on-par` packages move to 0.9.1 in lockstep.
Install or update with `npm install -g @on-par/factory-cli@latest`.

### Changed

- README rewrite for On PAR Dev's Software Factory: npm install Quick Start
  (`npm install -g @on-par/factory-cli`, `factory --version`, `factory doctor`),
  an accurate pitch, prerequisites (Claude Code signed in, `gh auth login`),
  and the safety note moved up under Quick Start. The `@on-par/factory-cli`
  README that npm shows, CONTRIBUTING.md and SECURITY.md match it (#2377,
  #2352, #2374).
- `@on-par/factory-cli` has a new npm description and keywords (#2377).
- Both READMEs open with a short GIF of a factory run (#2379).
- The footer the factory adds to its PR bodies now says "On PAR Dev's
  Software Factory" (#2377).
- KPIs count landed and admin-merged factory PRs as merges (#2373).

### Added

- `factory self-update --check [--json]` compares the running version with
  the npm `latest` dist-tag. It only reports; it installs nothing (#2370).
  Installing updates is still planned (#2355).
- `factory daemon run --update-mode manual|stable|prerelease` (default
  `stable` on npm installs) and `factory status` showing the update mode,
  current and available version and last update result. The mode is recorded
  only; factoryd does not install updates yet (#2367, #2372).
- Base holds: an environment pause persists a hold on the base SHA, claims
  are refused while it is active, `factory status` shows it, and it clears on
  a new SHA or green main CI (#2353, #2357, #2359, #2360).
- A pre-PLAN main-health check, cached per base SHA (#2362).
- State and config can live outside the checkout (`stateRoot` via flag or
  env), so a repo needs no in-repo `.factory/` (#2358).
- Infrastructure CI failures are classified separately from test failures,
  rerun once per PR head SHA, and parked as `ci-infra` (skipped by the
  steward) when they repeat (#2368, #2369, #2371).

### Fixed

- Reclaiming an issue released by an environment pause reuses its frozen
  plan instead of planning again (#2376).

## 0.9.0 - 2026-10-11

First npm release of the seven `@on-par` packages (`adr-kit`, `contracts`,
`repo-context`, `factory-config`, `factory-core`, `factory-tui`,
`factory-cli`). Versioning restarts at 0.9.0; nothing was published before,
and 1.0 follows once the release is proven.

### Changed

- Every workspace is now at version 0.9.0 (was 2.0.0), with `^0.9.0` ranges
  between the `@on-par` packages. `factory --version` prints 0.9.0 (#2244).
- The `Publish` workflow takes its version and npm dist-tag from the tag name:
  `vX.Y.Z-next.N` publishes `X.Y.Z-next.N` to `next`, `vX.Y.Z` publishes
  `X.Y.Z` to `latest`, and any other tag fails. `scripts/set-release-version.sh`
  sets the seven packages to one version with exact internal pins (and fails,
  naming the package, when they are not in lockstep).
  `scripts/publish-workspaces.sh --tag next|latest` refuses the wrong channel
  for the version and skips packages already on the registry, so a
  half-finished publish can be rerun (#2244).

### Security

- Agent CLI child processes (claude, codex, opencode), the commands they
  propose, and checker commands no longer inherit GitHub credentials
  (`GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN` and other `GITHUB_*`/`GH_*` token, PAT, secret or
  private-key variables). Only the factory's own `gh`/`git` calls receive them.
  Failed-command errors and output have GitHub credentials redacted. If a
  repo's build or test command needed `GITHUB_TOKEN`, it no longer gets it from
  the factory's environment.

### Fixed

- `factory init` no longer exits 2 when no GitHub token is available; it
  prints a warning and initializes `.factory/` anyway, since init never calls
  GitHub (`factory ship`/`run` still need a token). The `Publish` workflow's
  Quickstart smoke step now gets `GH_TOKEN`, like `ci.yml`'s job, so the v0.9.0
  publish no longer stops there. (#2346)
- The `Publish` workflow can no longer go green without publishing. When the
  v1.0 blockers are open, the ref is not a `v*` tag, or `npm publish` fails,
  the job fails. Every run writes `PUBLISHED <name@version ...>` or
  `NOT PUBLISHED: <reason>` to the job summary and sets the step output
  `published=true|false`. A manual run (`workflow_dispatch`, dry run by
  default) packs every package and reports `dry-run, not published` (#2335).

### Removed

- Removed the bundled `camp-somewhere-cli` constitution. This was a breaking
  change for anyone relying on the bundled constitution for that product; seed
  your own repo's constitution instead with `factory constitution --init <product>`.

### Packaging

- Every published `@on-par/*` tarball now carries a README and the MIT
  LICENSE, and ships `dist/` only: no test files, no `src/`, no
  `.tsbuildinfo`, and no `factory-core` test-support kit (#2336).
  `@on-par/factory-config` now bundles its constitution markdown under
  `dist/constitutions/` (the `./constitutions/*` export points there).
  `@on-par/factory-core/testing` stays the documented home for test doubles.
- `npm pack` (and so `npm publish`) fails when a package has no built `dist/`,
  instead of producing a tarball that holds only `package.json`.
