# Optimization review — simplification, hardening, token use, performance (2026-09-22)

A repo-wide read-only audit, run as seven parallel review passes (core pipeline/router/harness; core
sandbox/hosted/daemon/checkers; core queue/state/reporting; CLI/server/TUI/dashboard; product/scbench/contracts/
repo-context/adr-kit; tooling/CI/evals; abandoned-work cleanup). Every finding below was verified against the code
at the cited `path:line` on the review date; line numbers will drift. Severity is impact if left alone; effort is
S (< half a day), M (1–3 days), L (a week+).

Findings that several passes reported independently are merged and marked **(×N)**.

## Contents

1. [Top priorities](#1-top-priorities)
2. [Cross-cutting themes](#2-cross-cutting-themes)
3. [Hardening](#3-hardening)
4. [Token optimization](#4-token-optimization)
5. [Performance](#5-performance)
6. [Simplification](#6-simplification)
7. [Areas checked and found sound](#7-areas-checked-and-found-sound)
8. [Abandoned / unfinished work](#8-abandoned--unfinished-work)

---

## 1. Top priorities

The ten items with the best impact-to-effort ratio. Most are S effort.

| #   | Item                                                                                                | Cat.   | Sev. | Effort | Section |
| --- | --------------------------------------------------------------------------------------------------- | ------ | ---- | ------ | ------- |
| 1   | Merges are not pinned to the CI-verified head SHA (CLI land path _and_ auto-merge sweep) **(×3)**   | harden | high | S      | H1      |
| 2   | `factory stop` during merge wait marks an unmerged issue `done` and drops it from the queue         | harden | high | S      | H2      |
| 3   | Sandbox gaps: `docker-sandbox` contains nothing; 3 of 5 agentic harnesses ignore the policy         | harden | high | M      | H3, H4  |
| 4   | Sandbox write allow-list (`.git`, `~/.config`, `~/.local`) lets a contained agent plant host code   | harden | high | M      | H5      |
| 5   | Worktree GC zero-fills through symlinks → can overwrite host files (`~/.ssh/…`)                     | harden | high | S      | H6      |
| 6   | Claude CLI `--include-partial-messages` into a 10 MB buffer → overflow misread as timeout           | harden | high | S      | H8      |
| 7   | GitHub-label queue reads one page of 100; stale-claim reaper and `enqueue` likewise                 | harden | high | S      | H10     |
| 8   | Prompts put volatile text first — defeats prefix caching; spec + design sent 2–3× in BUILD **(×2)** | token  | high | S      | T1, T2  |
| 9   | ADR mandate flag is never read — ADR drafting/injection always on (~3.7k tokens per PLAN here)      | token  | med  | S      | T4      |
| 10  | Test suite runs single-threaded; CHECK fast path does a cold `npm ci` every round                   | perf   | high | S–M    | P1, P2  |

---

## 2. Cross-cutting themes

- **No shared "loopback JSON server" helper.** `core/daemon/factoryd-http.ts` has a correct Host/Origin gate, a
  body cap, a content-type check and a top-level 500 catch. `packages/server` and `core/hosted/control-plane.ts`
  have none of these. (H13, H14)
- **Non-atomic, unlocked state files.** These use a plain `writeFileSync` or a fixed `${file}.tmp` name while being
  shared across lanes or processes: `ports.json`, `registry.json`, the queue file, `LaneFileGuard`, `daemon.pid`.
  `withFileLock` already exists in `utils/lock.ts`. (H11, H12, H17)
- **Missing pagination** on GitHub list calls: the label queue, stale claims, filing dedupe, decompose sub-issues
  and the ingest watermark. (H10, H18)
- **Inconsistent secret redaction.** `redactSecrets` exists (`router/failure-detail.ts:8`), but it is not applied to
  SHIP push errors, hosted `logsTail`, or `captureFailure` excerpts. (H15, H20)
- **Git/exec calls without timeouts.** SHIP's default runner, worktree GC, scbench nested runs and nightly-evals all
  lack them, despite `execGit`'s 120 s deadline existing for exactly this (#755). (H9, H19)
- **Prompt assembly has no single builder.** Each phase orders content differently. The spec, design, constitution
  and ADRs are duplicated or uncapped, and the ordering is not prefix-cache friendly. (T1–T6)
- **Large unwired surface area.** About 3k lines of core subsystems, half of `packages/product`, and
  `packages/server` have no production caller. The barrels hide them from knip. (S1, §8)
- **Head-truncated tool output.** Checker failures and scbench retry briefs keep the _first_ N chars, which are
  npm or pytest preamble, and drop the actual error at the tail. (T7, T11)

---

## 3. Hardening

### H1. Merges are not pinned to the verified head SHA **(×3)** — high, S

- `packages/cli/src/cli/index.ts:3644` watches CI by branch name. `:3449` calls `pulls.merge` without `sha`, and
  `:3445` runs `gh pr merge --admin` without `--match-head-commit`. Up to about 75 s of lock/retry sits between the
  green verdict and the merge, and a push in that window gets merged unverified. `skipCI && adminMerge` merges with
  `--admin` and no CI at all.
- `scripts/auto-merge-sweep.sh:101-102,126-132`, `scripts/filter-green-prs.py:201-210`, and the plist template
  `:36-37` (`FACTORY_MERGE_ADMIN=1` by default): the filter only checks that the checks _present_ are all SUCCESS, so
  a PR where only gitleaks has reported qualifies, and the merge is not pinned to a SHA.
- `packages/core/src/utils/ci-watch.ts:55-71,97-117` reads only check-runs, never commit statuses. Callers pass no
  `minChecks`, so "success" rests on a 30 s settle window.
- **Fix:** have `watchChecks` return the SHA it verified, and pass it as `sha` / `--match-head-commit`. Treat a 409
  as "re-watch". Refuse `adminMerge` when `skipCI` is set. In the sweep, require `mergeStateStatus == CLEAN` and make
  `--admin` opt-in. Merge `getCombinedStatusForRef` into the CI watcher, and derive `minChecks` from branch
  protection.

### H2. STOP during `waitForMerge` counts as merged — high, S

`cli/index.ts:3949,4008-4010` returns normally when the STOP file appears. `runLane` (`:3303-3305`) then runs
`merged++` and `releaseIssue(issue,'done')`, and `github-queue.ts:434-447` strips the queue labels. **Fix:** return
`'stopped'` or throw a typed error, and release as `queued`.

### H3. `docker-sandbox` runtime contains nothing — high, M

`core/src/sandbox/index.ts:159-163,237` returns the command unwrapped. `utils/microvm.ts:74-110` only runs
`sbx create`, never `sbx exec`. With `rolloutPercent > 0`, lanes that auto-detected firejail or sandbox-exec are
moved to it silently, and a VM-create failure falls back to running uncontained. **Fix:** treat it as `none` and
emit `sandbox-unavailable` until commands actually run in the VM. Never let the rollout replace an available
runtime, and fail closed when it is pinned.

### H4. Sandbox policy ignored by opencode, ollama-agentic and the router's command agent — high, M

`harness/opencode.ts:111,136` (`--auto`, no wrap); `harness/ollama-agentic.ts:125,206-212` (`verifyCommand` runs
unsandboxed); `router/index.ts:149-151,299-307`. `phases/build.ts:190-195` still logs "containment active".
**Fix:** wrap every agentic exec, or have the router refuse or filter harnesses that can't honour a requested
sandbox. Add a harness-contract test for this.

### H5. Sandbox write allow-list enables host code execution; reads are unrestricted — high, M

`sandbox/index.ts:165-186,224`: `writablePaths` includes `<repo>/.git` (hooks and config), `~/.config` and
`~/.local`. Host git calls (`ship.ts:462,530`, `router/index.ts:333`) never pass `-c core.hooksPath=/dev/null`,
`core.fsmonitor=false` or `--no-verify`. SBPL `(allow default)` and firejail `--read-only=/` leave `~/.ssh` and
`~/.aws` readable. **Fix:** narrow writes to `.git/worktrees/<name>`, objects and refs. Harden every host git
invocation in `execGit`. Deny reads of credential directories.

### H6. Worktree GC credential scrub follows symlinks — high, S

`utils/worktree-gc.ts:229-271,743-751` uses `statSync`/`existsSync`/`readdirSync` (all of which follow links), then
`writeFileSync` of zeros. If an agent plants `.env → ~/.ssh/id_ed25519`, GC destroys the host key. **Fix:**
`lstatSync`, a realpath containment check, and remove the file rather than zero-fill it.

### H7. CHECK runs agent-written scripts unsandboxed with the full host env — high, M

`checkers/index.ts:90-282,425-430` and `utils/command-runner.ts:421-429` (`extendEnv: true`). `check.ts:303` passes
`sandbox` only to rework. A contained BUILD can get host execution by editing `package.json` scripts. **Fix:** apply
the BUILD sandbox policy to checker commands and checker agents, and start them from an env allow-list.

### H8. Claude CLI stream buffering → false "timeout" → provider block + hard reset — high, S

`harness/claude-cli.ts:134,142,153` runs `--output-format stream-json --include-partial-messages --verbose` into a
10 MB `maxBuffer` (`utils/exec.ts:80-83,121`). An overflow sets `killed`, which is classified as `timeout`. The router
then blocks all Anthropic models and runs `git reset --hard` (`router/index.ts:740-755,773-776`). **Fix:** drop
`--include-partial-messages`, which nothing consumes. Stream-parse only `result`/`error` plus a bounded tail, and
classify buffer overflow separately.

### H9. SHIP git has no timeout, no prompt suppression, and a 1 MB buffer — high, S

`phases/ship.ts:21,83,141,210,348,403-416,556,679` uses bare `promisify(exec)`, so a credential prompt or stalled
push hangs the lane forever. `inspectRecoveryState` runs `git status --porcelain` outside any try. **Fix:** set a
timeout, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, and use `-uno`.

### H10. GitHub-label queue: single page of 100 — high, S

`queue/github-queue.ts:282-299`, used by `claimNext`, `list`, `lanes`, `enqueue` and `readGithubQueueSnapshot`, and
by `stale-claims.ts:64`. With more than 100 queued issues the lowest-ordered ones are never claimed, and `enqueue`
can mint a duplicate position. `orderedCandidates` (`:213-217`) then throws, which stops the whole lane. **Fix:**
`octokit.paginate`, and skip-and-log bad items instead of throwing.

### H11. `LaneFileGuard` loses claims and has check-then-act races — high, M

`run/lane-file-guard.ts:51-56,83-98` and `run/run-issue.ts:417-429`: an unlocked read-modify-write through a fixed
`.tmp` file, `findCollision` followed by a separate `register`, and no expiry for crashed lanes. **Fix:** an atomic
`claimIfFree` under `withFileLock`, unique tmp names, and a pid/TTL-based stale reap.

### H12. Shared state files written non-atomically or unlocked — medium, M

- `environment/index.ts:90-93,269-271` (ports.json; the proxy reads a partial file as `[]`)
- `daemon/registry.ts:138-149`, `repos-attach.ts:71-72`, `repos-detach.ts:61-106` (unlocked, shared tmp name)
- `daemon/runtime-state.ts:80-92` (pid file without `wx`)
- `ingest/index.ts:193,246` (queue file; the CLI also writes it at `index.ts:1657,2413`)

**Fix:** tmp + rename with unique names, `withFileLock` around read-modify-write, and `open(..., 'wx')` for the pid
file.

### H13. `packages/server`: no Host/Origin guard, unhandled async rejection, SSE without backpressure — medium, S

- `server/src/index.ts:112-138`: any web page can `POST /…/pause`, and DNS rebinding exposes `/events`.
- `:128`: a rejected async handler crashes Node.
- `:99,152-162`, `sse.ts:42-45`: `write()` ignores backpressure, there is no client cap, and replay mixes ids
  across repos on the unscoped stream.

**Fix:** reuse factoryd's guard, catch in the handler, drop slow clients, cap client count, and use a global id for
the unscoped stream. See also §8: the package is not wired up.

### H14. Hosted control plane: no Host/Origin/content-type check, no body cap, no catch — medium, S

`hosted/control-plane.ts:170-188,203-223`: a `text/plain` POST from any page can create jobs or steal leases.
**Fix:** extract factoryd's gate into a shared `loopbackJsonServer` helper, and use it in all three servers.

### H15. Hosted token in argv, in the mounted `.git/config`, and in unredacted log tails — high, S

`hosted/docker.ts:67,70` clones with `https://x-access-token:<tok>@…`. `hosted/container.ts:444,456` stores
`logsTail` raw (`runner.ts:219` does redact). **Fix:** use a credential helper or `GIT_ASKPASS`, and redact
`logsTail`.

### H16. Hosted job orchestration duplicated and drifted — medium, M

`hosted/container.ts:382-497` vs `hosted/runner.ts:138-282`. The container path heartbeats only once, so jobs
longer than the lease TTL are reclaimed and run twice. Neither path handles failures before the `try`, which leaks
the lease and the temp dir. **Fix:** a single `executeLeasedJob`.

### H17. Every claim and heartbeat mints a permanent repo label — medium-high, M

`queue/github-queue.ts:65-71,83-89,421-423,463-469` creates `factory:claim-expires:<epoch>` and never deletes it.
That is about 12 new repo labels per lane-hour. **Fix:** store the lease elsewhere (a comment marker or a
ProjectV2 field), or at minimum `deleteLabel` the old one and sweep orphans.

### H18. Ingest watermark can permanently skip ready issues — medium-high, S

`ingest/index.ts:101-116,175-178,242-267`: the watermark advances to the max `updatedAt` of a truncated page.
**Fix:** use `updated:>WATERMARK sort:updated-asc`, or advance only when the page is not full.

### H19. Other missing timeouts — medium, S

- `utils/worktree-gc.ts:3,17,273-276,473` (network git, no timeout; use `execGit`)
- `scbench-adapter/src/workspace.ts:234-245` (nested factory/launcher runs; also caps `detail` at about 2 KB)
- `daemon/engine-supervisor.ts:141-175` (`stale.stop()` has no deadline, so the supervisor wedges)
- `.github/workflows/nightly-evals.yml` (no `timeout-minutes`, worst case about 7 h), `publish.yml`,
  `secret-scan.yml`, `codeql.yml`
- `repo-context/src/github.ts:111` (`FetchLike` can't carry an `AbortSignal`)

### H20. Secrets reaching logs and events unredacted — low-medium, S

`phases/ship.ts:619-625,644-649` (push/ls-remote stderr); `failure/index.ts:60` (`eventExcerpt` would be filed to
GitHub). **Fix:** `redactSecrets` before truncating.

### H21. Ctrl-C leaves detached agent process groups running — high, M

`utils/exec.ts:58` and `supervised-exec.ts:28` spawn with `detached: true`. `factory run|ship|run-issue|run-brief|
supervise` install no signal handler, so child `claude`/codex processes keep running (and spending tokens). The
proxy's `proxy.json` and claim labels are also left behind. **Fix:** one `installShutdown(controller)` that
aborts, writes STOP, kills tracked pgids, releases leases and sets exit code 130.

### H22. Untrusted text reaches terminals unsanitized — medium, S

`sanitizeTerminalText` (#1362) is applied only in some TUI components. Raw issue titles and stderr still reach
`tui/.../EventFeed.tsx:27`, `cli/index.ts:1109-1113` (status), `logs.ts:26`, `tui/src/fallback.ts:20` (via
`core/src/utils/format.ts:63`) and ApprovalPrompt. **Fix:** sanitize once, in `formatEventLine` and at the render
sites.

### H23. Workflow supply chain and permissions — medium, S

All 18 `uses:` lines are pinned by tag. `ci.yml` has no `permissions:`, and passes an unused `GH_TOKEN`
(`:111-112`). `publish.yml` uses a long-lived `NPM_TOKEN` without provenance. The nightly-evals job installs
`@anthropic-ai/claude-code` unpinned while holding the API key. **Fix:** pin to SHAs (with Dependabot), set
`permissions: contents: read`, and use `--provenance` / trusted publishing.

### H24. Publish workflow ships 3 of the 7 packages the CLI needs — high, S

`.github/workflows/publish.yml:20-37` publishes config, core and cli, but core needs adr-kit, contracts and
repo-context, and cli needs tui. `quickstart-smoke.sh:108-116` packs all 7, which masks the gap. The gate still
references "v1.0 blockers". **Fix:** publish from one shared list.

### H25. Evals run `bypassPermissions` in the repo checkout; judge prompt is injectable — medium, S

`scripts/eval.ts:143` uses `worktree: process.cwd()`. `eval/judge.ts:175-188` pastes the spec under test
undelimited. **Fix:** an `mkdtemp` worktree, `<spec>` tags marked as untrusted, and no tools for the judge.

### H26. Smaller hardening items

| Item                                                                                                  | Location                                                                                                                | Fix                                                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `factory run` drops lane crashes (`allSettled` ignored); watchdog not aborted on error path           | `cli/index.ts:2908-2916`                                                                                                | Inspect results, emit `lane-crashed`, abort in `finally`         |
| Approval responses cast, not validated (`"approved":"no"` is truthy); timeouts stay pending           | `approvals/index.ts:64-107`                                                                                             | zod + id match; write a timeout deny                             |
| Docker jobs lack `--memory/--cpus/--pids-limit/--cap-drop/no-new-privileges`; 1 MB buffer → "timeout" | `hosted/docker.ts:95-117`                                                                                               | Add limits; distinguish maxBuffer; `docker kill` on timeout      |
| `npx tsc` can fetch the `tsc` placeholder package from the registry                                   | `checkers/index.ts:281-287`                                                                                             | `npx --no-install` or SKIP                                       |
| `local-small` stepwise runs model `verifyCommand` through a shell without the allowlist               | `local-small/stepwise.ts:156-195,242-299`                                                                               | Delete it (no caller) or reuse `validateVerifyCommand`           |
| OpenCode prompt on argv (E2BIG at 128 KiB, visible in `ps`); stderr chatter → `usage_cap`             | `harness/opencode.ts:136,147`                                                                                           | stdin from a 0600 temp file; classify only opencode's own lines  |
| Codex prompt temp files world-readable                                                                | `harness/codex-cli.ts:32-33,80-84`                                                                                      | `mkdtemp` + mode 0600                                            |
| Steering attachments: no total cap; symlink escape                                                    | `steering/index.ts:121-175`                                                                                             | Budget ~100 KB; realpath check                                   |
| Readiness enrichment overwrites the human issue body with model output                                | `phases/plan.ts:311-314`                                                                                                | Post as a comment or keep the original; cap length               |
| Evidence-pack comment can exceed 65,536 chars; 422 swallowed by `catch {}`                            | `reports/evidence-pack.ts:65-129`, `phases/ship.ts:295-306`                                                             | Cap timeline/design; truncate; log a warning                     |
| KPI human events hardcode the `ship-it/` branch prefix; ~900 API calls per run                        | `kpis/human.ts:175-231`                                                                                                 | Use the configured prefix; bound concurrency; cache              |
| `parseKpiHistory` throws on one malformed line                                                        | `kpis/index.ts:800-805`                                                                                                 | Skip-and-count like `readCostsFile`                              |
| Decompose dupe guard sees only the first 30 sub-issues                                                | `readiness/decompose.ts:425-440`                                                                                        | Paginate                                                         |
| Untrusted `</untrusted-…>` fence not escaped                                                          | `readiness/enrich.ts:33-55`, `decompose.ts:87-93,603-606`                                                               | Escape the closing tag; cap body                                 |
| scbench manifest parsed via cast; malformed manifest crashes the CLI                                  | `scbench-adapter/src/artifacts.ts:54-86`, `baseline.ts:423-513`                                                         | zod `BenchmarkManifestSchema` + `loadManifest`                   |
| Product cue matching is substring-based (`'pm'` ⊂ "development", `'auth'` ⊂ "author")                 | `product/src/interview/dimensions.ts`, `persona/rules.ts`, `intent/statements.ts:43-49`, `architecture/design.ts:75-88` | Word-boundary regex; single best dimension                       |
| Readiness gate's `designCritique` typed as `JudgeReport`, so the ADR critic can never block           | `product/src/readiness/artifacts.ts:53-55`, `report.ts:92-117`                                                          | Type as `EpicDesignCritique`                                     |
| `exportToGitHub` not idempotent; bundle comments can exceed 65 KB                                     | `product/src/export/github.ts:37-70`                                                                                    | Fingerprint marker; split large files                            |
| ADR parser: headings inside code fences, quoted `status:`, unterminated frontmatter                   | `adr-kit/src/parse.ts:44-130`                                                                                           | Track fences; unquote; throw                                     |
| repo-context: silent 1,000-entry dir truncation; secondary rate limit → `unauthorized`                | `repo-context/src/github.ts:192-315`                                                                                    | Emit `truncated`; classify 403 + `retry-after` as `rate-limited` |
| Lane proxy: `stop()` can hang on keep-alive; upstream not aborted on client close                     | `proxy/index.ts:160-263`                                                                                                | `closeAllConnections()`; destroy upstream on close               |
| CLI entry `process.exit(1)` after `console.error`; non-Error throws print `undefined`                 | `cli/src/cli.ts:6-9`, `cli/index.ts:4352`                                                                               | `process.exitCode`; stringify                                    |
| Stub eval passes when zero cases load                                                                 | `scripts/eval.ts:135-177`                                                                                               | Fail on 0; compare count to baseline                             |
| `cancel-in-progress` cancels `main` runs too                                                          | `ci.yml:9-11` (+ codeql, secret-scan)                                                                                   | Only for `pull_request`                                          |
| Sweep usage guard exits 0 → launchd respawns every 30 s                                               | `auto-merge-sweep.sh:183-187`, plist `:28-31`                                                                           | Placeholders; `KeepAlive.SuccessfulExit=false`                   |

---

## 4. Token optimization

### T1. Prompt order defeats prefix caching — medium, S

`phases/plan.ts:60-67`, `build.ts:355-358,400-403,446-450` and `check.ts:432-439` all open with issue-specific
text (`issue #N`, `WORKTREE:`, `SPEC:`), followed by about 3.8k tokens of constitution, about 3.7k of ADRs and
about 5.7 KB of fixed instructions. Anthropic and OpenAI caching are both prefix-based, so parallel lanes on one
repo never hit the cache. **Fix:** one shared prompt builder that orders content as static role/instructions →
constitution → ADRs → issue/spec/failures → steering.

### T2. BUILD sends the spec twice and the design block three times **(×2)** — medium-high, S

`phases/build.ts:129-131,355-361,387,400-406,432`: the codex, opencode and commit-only prompts inline the _raw_
spec, including YAML frontmatter (the full `design:` block and `adr:` drafts). They then append
`renderDesignGrounding`, then tell the agent to read `specPath` as well. The checker prompts (`checkers/index.ts:408`,
`design-smells.ts:393-405`) also receive the raw frontmatter. **Fix:** pass `parseSpec(raw).body` plus the compact
grounding, and drop the "read the spec at path" instruction when the spec is inlined. Never send `adr:` drafts to
BUILD.

### T3. Constitution uncapped, re-sent everywhere, double-loaded on codex/opencode — medium-high, M

`constitutions/index.ts:72-96,150-176` concatenates CLAUDE.md + AGENTS.md + copilot-instructions with no cap (about
3.8k tokens here). It goes into PLAN, BUILD, every rework round and every custom checker. Codex and opencode also
auto-load AGENTS.md, so they receive it twice. The `enforced_on` frontmatter is never read. **Fix:** cap at about
8 KB, skip AGENTS.md for harnesses that auto-load it, honour `enforced_on` or delete it, and build per-phase views
(Standards only for BUILD).

### T4. ADR mandate flag never consulted — medium, S

`config/index.ts:407-409` defines `resolveAdrMandate`, and nothing calls it. PLAN always carries the ADR-draft
schema (about 1 KB) plus the accepted-ADR block (about 14.8 KB / 3.7k tokens for this repo). SHIP writes ADRs into
every target repo. `readAdrContext` reads 104 files sequentially, and SHIP reads them again. The PLAN prompt also
hard-codes model names (`plan.ts:81,83`) and explains route choice even when the route is forced. **Fix:** thread
`adrMandate` into plan/ship, read ADRs with `Promise.all` or reuse PLAN's context, and drop route text when the
route is forced.

### T5. Routing sends large prompts to small-context, tool-less local models — high, M

`config/src/defaults.ts:404-449` (tiers) and `:258-305` (`num_ctx` 8192/16384). `checker` is led by `qwen3.5:9b`
(8k context, `ollama-http`), while `check_design` sends up to 120k chars of diff and `check_custom` asks the model to
"run commands". After an Anthropic cap, `boss` falls through to a 16k, non-agentic model. `contextWindow` is never
read. **Fix:** skip models whose effective context is below the estimated prompt size, and add
`requires: 'agentic'` to routes.

### T6. Rework loop re-runs every LLM checker with full context — medium, M

`phases/check.ts:286-324,428-450` and `checkers/index.ts:536-542`: each of up to 3 rounds re-sends the full
constitution and re-runs `check_custom` and `check_design`, even when they passed. `runCustomChecker`
(`checkers/index.ts:402-422`) inlines the uncapped spec plus the whole constitution _per custom checker_. **Fix:**
cache verdicts by (checker, diff hash), apply `MAX_SPEC_CHARS`, send each checker only its own constitution
section, or batch custom checkers into one call.

### T7. Checker failure detail keeps npm boilerplate and drops the real error **(×2)** — medium, S

`utils/command-runner.ts:449-452` (`stderr || stdout`), with callers keeping `.slice(0, 500)` (300 for lint/tsc) at
`checkers/index.ts:100-292`. tsc and eslint write their diagnostics to stdout. The runner captures up to 100 MB in
order to keep 500 chars. **Fix:** merge both streams, strip npm lines and ANSI codes, keep error-looking lines plus
the tail, and capture into a ring buffer of about 256 KB.

### T8. `factory triage` bypasses the router and pulls 100 full issue bodies — medium, M

`cli/index.ts:2346-2377` always shells out to `claude -p`, silently dropping `--model` for non-Claude routes, which
also bypasses `localOnly`. The prompt says "Read every body" for `--limit 100`, and there is no timeout. **Fix:**
move triage into core via `ModelRouter`, pre-filter with octokit, send only title, labels and a truncated body.

### T9. Stale, repo-specific text in BUILD prompts **(×2)** — medium, S

`phases/build.ts:365-368,410-413` tells every target repo to run `scripts/verify.sh --no-e2e` because of "a known
multi-hour hang, #739". That is this repo's own bug and it is fixed. **Fix:** replace with a generic "run the
repo's fast verify command", or take the command from config.

### T10. Untrusted issue bodies uncapped in readiness prompts — medium, S

`readiness/enrich.ts:33-55`: up to 65k chars; the retry repeats both the body and the previous output. **Fix:**
cap at 8–12k; retries send only the previous output plus the missing headings.

### T11. scbench retry brief keeps the head of pytest output; failing-test list unbounded — medium, S

`scbench-adapter/src/retry-context.ts:131,167-191`, `brief.ts:98-111`. The brief becomes the task for all phases.
**Fix:** keep the tail, cap at about 30 names plus "+N more", and drop duplicate stderr.

### T12. Product epic architecture carries every ADR (~10.7k tokens, printed twice) — high (future), M

`product/src/architecture/adrs.ts:22-65`, `design.ts:50-137`, `critic.ts:81-185`, `render.ts:7-11`: no cap. The
critic _requires_ all 104 ADRs to be present, and each Decision is cut mid-sentence at 300 chars. **Fix:** keep
only relevant ADRs as `ADR-NNNN — title` plus a link, and reuse core's caps (20 × 600).

### T13. Product model seams shaped for re-sending — medium (future), M

`product/src/interview/interview.ts:49,84-111`: one call per question with the full dump and no transcript.
`judge/loop.ts:67-125`: serial per-story, each call receiving the whole `IntentDoc`. Note: nothing in `product`
calls an LLM today; these are design fixes to make before real seams are plugged in.

### T14. Always-loaded agent docs — low-medium, S

- AGENTS.md is 14.2 KB (about 3.5k tokens); 42% of it is the module inventory, while `agents-layout.test.ts` only
  needs the names.
- CLAUDE.md restates AGENTS.md's policy sections instead of importing it with `@AGENTS.md`.
- AGENTS.md contradicts the code in several places: Node ≥ 20 vs `engines >=24`; coverage floors 94/91/85/94 vs
  97/95/90/96; `--no-e2e` actually means "no coverage".
- The vitest `text` coverage reporter dumps a per-file table into agent transcripts
  (`vitest.config.ts:40`).

**Fix:** trim the inventory, point to the config instead of copying numbers, use `text-summary`, and rename the
flag to `--no-coverage` (keeping an alias).

---

## 5. Performance

### P1. Tests run single-threaded, configured in two places — high, M

`package.json:20,22` (`--maxWorkers=1`, 16 GB heap) and `vitest.config.ts:30-33` (`fileParallelism: false`). The
338 test files run serially on a 4-vCPU runner under a 20-minute ceiling. **Fix:** measure RSS with 2 workers or
`pool: 'threads'`, or shard with `--merge-reports`. Keep the constraint in one place, and make it conditional on
coverage.

### P2. CHECK fast path: cold `npm ci` + duplicated build/lint/typecheck every round — high, S–M

- `scripts/verify.sh:23` always runs `npm ci`.
- `checkers/index.ts:84-301,536-556`: compile runs `npm run build`, tests runs `verify.sh`, which builds, typechecks
  and lints again, and lint runs `npm run lint` + `npx tsc` again. All of this repeats every rework round, under a
  300 s timeout.
- Checkers keep running after `worker_output` has already failed (`check.ts:247-255` parks immediately anyway).
- Independent checkers run serially.

**Fix:** skip install when the lockfile is unchanged, short-circuit on a `worker_output` FAIL, mark compile/lint
"covered by verify.sh", and run fs and agent checkers concurrently.

### P3. CI: one serial job of about 12 steps; duplicate install and build; non-incremental typecheck — medium, M

- `ci.yml:14-113`: one serial job; `quickstart` repeats `npm ci` and the build.
- `typecheck` (`package.json:14,17`) is `tsc -b` (a no-op after build) plus 11 serial non-incremental `tsc --noEmit`
  passes.

**Fix:** parallel `static` and `test` jobs with a `ci` aggregator job, a composite `tsconfig.test.json` per package,
and one incremental `tsc -b`.

### P4. `events.ndjson` re-read in full and never rotated — medium, M

- `events/index.ts:8-21,74-86`: `readEvents` and `readIssueEvents` (a near-copy) each `readFileSync` the whole log.
- `reports/local-run.ts:130-146`, `evidence-pack.ts:96`, and `cli/index.ts:1109,1122` (status reads it twice),
  `:1817,1869,1963,2921` all parse the full file.
- `followEvents` allocates the full file on its first tick and decodes chunks with `toString`, which breaks
  multibyte characters split across a boundary.
- The TUI replays the whole log with a per-event array copy, which is quadratic (`tui/src/components/App.tsx:146-156`).

**Fix:** one streaming reader with a predicate, `StringDecoder`, tail-reads for `status`, size-based rotation, and
batched TUI replay.

### P5. Every log line takes a synchronous directory lock (up to 10 s spin) — medium, M

`logger/index.ts:66-85`, `utils/lock.ts:152-202`. This blocks the heartbeat and pollers in the same process.
Single-line `O_APPEND` writes are already atomic on local filesystems. **Fix:** a lock-free append below about
64 KiB, or keep one fd open.

### P6. `getOctokit()` runs a blocking `execSync('gh auth token')` per call — medium, S

`cli/index.ts:302-315` is called 20+ times per run (per `shipIssue` and `waitForMerge`, in the TUI poll, even for
local-only `run-brief`). Each call also builds a new Octokit, so throttling state isn't shared across lanes.
**Fix:** memoize the token and client, and skip them when `localOnly`.

### P7. CLI eagerly imports the whole engine plus Ink/React for every command — medium, M

`cli/index.ts:1-236`: about 250 core symbols plus `@on-par/factory-tui` load before argv is parsed.
`cli/src/cli/staleness.ts:19-137` also walks about 470 src files on every invocation. **Fix:** split into per-command
modules with `await import()` (see S3), and use a single build stamp.

### P8. Daemon run store rewrites all history with regex redaction every second — medium, S

`daemon/run-runtime.ts:83-324`: records are unbounded (up to 128 KB of log each), each `persist()` re-sanitizes
everything, and there are per-record sync ownership reads on every request. **Fix:** cap retained records, keep
per-run log files, and sanitize each chunk once.

### P9. Smaller performance items

| Item                                                                           | Location                                                                 | Fix                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Same git diff collected twice per CHECK round (4–6 git spawns ×2)              | `checkers/design-smells.ts:386-442,479,654`                              | Compute once in `probeWorktree`                     |
| Nightly eval judge samples run serially (11 cases × 4 calls × up to 600 s)     | `eval/runner.ts:21,25`, `eval/judge.ts:135-145`                          | `Promise.all` for samples; bounded case concurrency |
| Pollers log an info event on every successful poll (~2,880/day each)           | `projects/project-queue-poller.ts:83-87`, `usage/coordinator.ts:153-155` | Log at debug or only on change                      |
| Usage estimator re-reads every Claude transcript from 0 each poll (sync)       | `usage/index.ts:40-230`                                                  | Keep offsets; async fs                              |
| TUI 500 ms clock + 2 s polls re-render the whole tree while idle               | `tui/src/components/App.tsx:158-200`                                     | Tick only while running; skip if mtime unchanged    |
| Lane proxy does a sync read + parse of ports.json per request                  | `proxy/index.ts:174`                                                     | Cache by mtime                                      |
| ADR readers read ~112 files sequentially (115 requests on the GitHub reader)   | `core/src/adr/index.ts:44-104`, `product/src/architecture/adrs.ts`       | Bounded parallel read (and S5)                      |
| repo-context GitHub reader: no memoization; `exists()` downloads the full file | `repo-context/src/github.ts:207-328`                                     | Per-path promise cache; derive from `readDir`       |
| Secret scan re-scans full history on every PR                                  | `.github/workflows/secret-scan.yml:21-35`                                | PR range on PRs; full scan on main/weekly           |
| Product CLI re-runs the interactive interview for every command                | `product/src/cli/program.ts:92-302`                                      | Persist `IntentDoc`/`Decomposition` JSON            |

---

## 6. Simplification

### S1. About 3k lines of production-unwired core subsystems; `internal.ts` over-exports — high, M

These have no non-test caller outside core:

- `filing/` (`fileBug`), `failure/` (`captureFailure`)
- `discovery/` (`index.ts:356`, `author.ts:144`, `promote.ts:233`)
- `usage/` coordinator, local-coordinator, select-coordinator, lane-scheduler and grant-ledger
- `queue/` project-board-poller, project-board-status-writer and queue-backend
- all of `projects/*`
- `phases/board-queue-{scheduler,dispatch}.ts`

284 of `internal.ts`'s 381 exports, and 321 of `index.ts`'s 521, are unused outside core. knip can't see this
because the barrels are package entry points. **Fix:** decide wire-or-delete per subsystem (see §8), trim the
barrels, and add a CI check for unconsumed `internal.ts` exports.

### S2. Duplicate implementations to merge

| Duplicate                                                                                                          | Locations                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two ProjectV2 board readers/pollers (identical GraphQL) + two status writers + 3× poller scaffold                  | `queue/project-board-poller.ts` vs `projects/project-queue-{reader,poller}.ts`; `usage/coordinator.ts:147-191`                                                                                                                                                              |
| Two board-queue dispatchers over different snapshot types                                                          | `phases/board-queue-dispatch.ts:138-166`, `phases/board-queue-scheduler.ts:53-91`                                                                                                                                                                                           |
| `buildOpencodePrompt` ≡ `buildCommitOnlyPrompt` (byte-identical); route→prompt switch written 3×                   | `phases/build.ts:345-433,165-287`                                                                                                                                                                                                                                           |
| Router worktree reset-or-throw copy-pasted; `parseGitStatusPaths` ×2; ~300-line unreachable `ollama-command-agent` | `router/index.ts:215-511,740-841,869-964`, `router/worktree-state.ts:107-117`                                                                                                                                                                                               |
| `execDetached` ≈ `runCommandDetached`; `withFileLockSync` ≈ `withFileLock`; 4× `isPidAlive`; 4× shell-quote        | `utils/exec.ts:105-192`, `utils/command-runner.ts:324-410`, `utils/lock.ts:152-260`, `environment/index.ts:106`, `daemon/runtime-state.ts:59`, `daemon/process-ownership.ts:4`, `utils/index.ts:281`, `utils/microvm.ts:25`, `hosted/docker.ts:50`, `hosted/orphans.ts:139` |
| factoryd has two `/runs` route trees; the `if (!runs)` at `:188-191` is dead                                       | `daemon/factoryd-http.ts:187-319`                                                                                                                                                                                                                                           |
| `runContainerJob` ≈ `runDockerRunner` (drifted, see H16)                                                           | `hosted/container.ts:382-497`, `hosted/runner.ts:138-282`                                                                                                                                                                                                                   |
| Config read → parse → zod-format pattern ×4                                                                        | `config/index.ts:343-368`, `config/repo.ts:196-216`, `config/v2.ts:413-435`, `config/policy.ts:103-116`                                                                                                                                                                     |
| `readCosts` vs `readCostsFile` (latter unused); NDJSON parsers ×4                                                  | `utils/index.ts:71-84`, `usage/index.ts:263-287`, `kpis/index.ts:800`, `events/index.ts`                                                                                                                                                                                    |
| ADR directory reader in core and product                                                                           | `core/src/adr/index.ts:12-104`, `product/src/architecture/adrs.ts:20-65` → move to `adr-kit`                                                                                                                                                                                |
| INVEST gate copy-pasted ("MUST change together")                                                                   | `product/src/decompose/invest.ts:5-67`, `core/src/readiness/decompose.ts:11-300`, `size.ts:1-11` → move to `contracts`                                                                                                                                                      |
| Bounded rework loop, `condense`, interview setup ×2–3                                                              | `product/src/judge/loop.ts:46-107`, `architecture/critic.ts:67-260`, `cli/program.ts:97-207`                                                                                                                                                                                |
| `runCheckpoint` ≈ `retryCheckpoint` (~45 lines); `REAL_FS` ×2                                                      | `scbench-adapter/src/run-checkpoint.ts:151-204`, `retry-checkpoint.ts:60-121`                                                                                                                                                                                               |
| Loopback JSON server guard (see H13/H14)                                                                           | `daemon/factoryd-http.ts`, `hosted/control-plane.ts`, `server/src/index.ts`                                                                                                                                                                                                 |
| `local-small/stepwise.ts` patch applier duplicates ollama-agentic's (and has no caller)                            | `local-small/stepwise.ts:156-299`                                                                                                                                                                                                                                           |

### S3. `cli/src/cli/index.ts` is a 4,781-line god file — medium, L

It holds commander wiring, the ship pipeline, lane scheduling (`runLane`, `superviseLoop`), and the PR land/merge
engine (about 680 lines, `:3366-4041`), with 25 `catch (err: any)` blocks. factoryd has to spawn the CLI binary to
reuse the land logic. **Fix:** move `land/` and `lanes/` into core, and turn the CLI into `commands/<name>.ts` files
with `register(program)`, which also enables P7. Extract the duplicated one-shot prelude (`cmdShip`, `cmdRunIssue`,
`cmdRunBrief`) and give `ModelRouter` an options-object constructor. The six-positional-arg construction is
repeated 4×, and `applyRepoConfig(loadModelsConfig())` 8×.

### S4. Tooling duplication

- `verify.sh` and `ci.yml` are hand-copied step lists that have already drifted: `install-sweep-plist.test.sh`
  never runs in CI. AGENTS.md has a third copy. Have CI call named `verify.sh` stages.
- `package.json` `test` and `test:coverage` are identical, and nothing calls the latter.

### S5. Contracts package carries demo and unused helpers — low, S

`contracts/src/hosted.ts:126-174` (`runHostedContractDemo`) is test-only. `serde.ts:10-31` is unused, while core
hand-rolls the same `safeParse` in `adr/write.ts:104,138`.

---

## 7. Areas checked and found sound

- **CLI auto-merge gating** (`landOpenPullRequest`) never merges on watch errors, timeouts or non-success. It
  re-watches after a rebase, and the label gate fails closed. The only gaps are H1 and H2.
- **Router** `failoversFrom`/breaker bookkeeping; the ollama-agentic proposal validator (strict allowlist, path
  checks, prepare-then-apply); steering drain atomicity; the ADR injection cap in core (20 × 600); the local-small
  spec cap.
- **repo-context**: path traversal and symlink confinement (`path.ts`, `fs.ts` realpath), binary rejection, base64
  handling.
- **scbench-adapter** uses argv-based execa (no shell injection) and deliberately avoids setting
  `ANTHROPIC_API_KEY`.
- **Atomic writes** done right: `run/state.ts`, `run/phase-snapshot.ts`, `config/policy.ts`,
  `usage/coordinator.ts`, grant-ledger.
- `projects/project-queue-reader.ts` paginates with a repeated-cursor guard. The bus isolates throwing
  subscribers. The CLI Octokit has retry and throttling plugins.
- **Lane proxy**: Host allow-list and 127.0.0.1-only dialing.
- **Dashboard**: bounded log tail, no `innerHTML`, zod-validated frames.
- **Workflows**: `discord-github-updates.yml` passes event fields through `env:` (no `${{ }}` injection); shell
  scripts use `set -euo pipefail`; gitleaks is SHA-verified; CodeQL permissions are scoped; the eval judge's
  `extractVerdict` is robust.
- **Not measured**: CLI startup time and `tsc` wall-clock. `node_modules`/`dist` were absent during the audit, so
  P3 and P7 are reasoned from configuration, not timed.

---

## 8. Abandoned / unfinished work

Method: full git history (613 commits, 2026-07-10 → 2026-09-19); consumers found with `grep -rlw` over non-test
sources (barrels and `public-api.test.ts` excluded); parent epics checked on GitHub. **Why knip misses this:**
`core` exposes `.`, `./internal` and `./testing` as package entry points, so everything re-exported from those
barrels looks "used". Open epic #1436 already tracks making dead code visible.

Verdicts: **REMOVE** = abandoned, no consumers — _removed on this branch_ (see §8.1). **DECIDE** = partially built;
owner must choose finish vs. delete. **KEEP** = looks unfinished but is used or intentional.

| #   | Item                                                                                        | Location                                                                                                  | Last activity                            | Verdict                                                 |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| 1   | GitHub ProjectV2 board queue (pollers, dispatchers, status writers, reprioritization)       | `core/src/projects/*`, `queue/project-board-*`, `queue/reprioritization-audit.ts`, `phases/board-queue-*` | 08-30; epic #773 closed superseded 09-16 | **REMOVE** (done)                                       |
| 2   | `applyLocalSmallPatchStep` (also an unsandboxed-shell risk, H26)                            | `core/src/local-small/stepwise.ts:156`                                                                    | 07-19                                    | **REMOVE** (done)                                       |
| 3   | `acquireLaneEnvironment`, `simWorkspace` + stale "later story" comment                      | `core/src/run/ports.ts`                                                                                   | 08-27                                    | **REMOVE** (done)                                       |
| 4   | Unreferenced PR-evidence screenshots                                                        | `docs/screenshots/{257,593}/`                                                                             | 07-15, 08-19                             | **REMOVE** (done)                                       |
| 5   | Stale "later stories" comment on `RunOutcome`                                               | `core/src/run/outcome.ts:7-9`                                                                             | —                                        | comment fixed (done)                                    |
| 6   | Stale remote branches (see §8.2)                                                            | `origin/ship-it/*`, `backup/606-*`, misc                                                                  | 07-24 → 09-01                            | **REMOVE** — _not done, needs owner_                    |
| 7   | factoryd in-process engine supervisor                                                       | `core/src/daemon/engine-supervisor.ts`, `daemon/run-repo.ts`                                              | 09-02; epic #764 parked                  | DECIDE (leans remove; see #1433)                        |
| 8   | Failure fingerprinting + auto bug filing                                                    | `core/src/failure/`, `core/src/filing/`; `filing.enabled: true` in defaults but unread                    | 07-20                                    | DECIDE                                                  |
| 9   | Discovery scan / draft-epic authoring / promotion (public root exports)                     | `core/src/discovery/*`; `discovery.*` config unread                                                       | 08-12                                    | DECIDE (removal = breaking API change)                  |
| 10  | UsageCoordinator, grant ledger, LaneScheduler                                               | `core/src/usage/{coordinator,grant-ledger,lane-scheduler,local-coordinator,select-coordinator}.ts`        | 08-30; epic #763 open                    | DECIDE                                                  |
| 11  | Hosted-exec control plane (CLI clients exist; nothing starts the server)                    | `core/src/hosted/{control-plane,runner,watchdog,store-*}.ts`                                              | 08-27; #940/#944 parked                  | DECIDE (keep `container.ts`/`docker.ts`)                |
| 12  | `packages/server` + dashboard live board + lifecycle bus (no producer; port clash)          | `packages/server`, `dashboard/src/useLaneEvents.ts`, `core/src/bus`                                       | 09-12; epic #583 open                    | DECIDE — mount `/events` in factoryd or delete          |
| 13  | `docker-sandbox` runtime + A/B rollout (contains nothing, H3)                               | `sandbox/index.ts:102-111`, `utils/microvm.ts`, `scripts/sandbox-ab-report.ts`                            | 08-31; #1531 unmerged                    | DECIDE — build `sbx exec` or drop for disposable-docker |
| 14  | `packages/product` readiness/export/architecture (not reachable from its CLI)               | `product/src/{readiness,export,architecture}`                                                             | 08-19; epic #463 idle since 07-25        | DECIDE                                                  |
| 15  | `createGitHubContentsReader` (only tests use it)                                            | `repo-context/src/github.ts`                                                                              | 07-25                                    | DECIDE (leans remove)                                   |
| 16  | ADR-0005 stuck at Proposed; missing from ADR index                                          | `docs/adr/0005-autonomous-factory-loops.md`                                                               | 07-26                                    | DECIDE (accept+scope or deprecate)                      |
| 17  | Local-small track (dry-run, overnight, scoreboard) — no feature work in 2 months            | `core/src/local-small`, `scripts/local-small-scoreboard.ts`                                               | 07-19                                    | KEEP/DECIDE (still CLI-reachable)                       |
| 18  | Deployment-automation research track (6 docs, ADR-0025/0026); Terraform spike never started | `docs/research/*deployment*`, `cloud-provisioning-guardrails.md`, `hosting-comparison.md`                 | 08-14                                    | KEEP (flag as stalled)                                  |
| 19  | `packages/tui`, `scbench-adapter`, `adr-kit`, `QueueBackend`, disposable-docker lanes       | various                                                                                                   | 09-03 → 09-19                            | KEEP (active)                                           |

### 8.1 Removed on this branch

Items 1–5 above. Each removal was re-verified with grep before deletion and the full `bash scripts/verify.sh` gate
was run afterwards (see the commit message for results).

### 8.2 Stale remote branches (not deleted — needs the owner)

Superseded by work already on `main`: `ship-it/148` (#457), `ship-it/511` (#518), `ship-it/522` (#540),
`ship-it/523` (#537), `ship-it/529` (#541), `ship-it/538` (#542), `ship-it/596` (#638/#680), `ship-it/606` and
`backup/606-prior-attempt` (#630), `ship-it/1007` (#1169).

Diff against `main` before deleting — may hold unlanded fixes: `fix/codex-gh-queue-recovery` (08-21),
`local-fixes-20260826` (08-26, contains a "WIP … parked before syncing main" commit),
`claude/architecture-diagrams-docs-90e8rl`, `claude/repo-skill-integration-aib3d6`. `codex/local-hosted-mvp` (10
commits ahead) is a real unmerged feature line — DECIDE with item 11.

Collision to watch: `ship-it/1525` adds ADR-0112, which already exists on `main`; it needs renumbering before merge.

### 8.3 Stale documentation statements

- AGENTS.md: Node ≥ 20 (actual `>=24`); coverage floors 94/91/85/94 (actual 97/95/90/96, 10 per-package blocks);
  `packages/server` "exposes only `GET /events` … no control endpoints" (it has `POST …/pause`); "ADR writer …
  consume them in later stories" (landed in #482).
- README.md: layout omits dashboard/product/tui/scbench-adapter; calls config "Shared JSON configs" (TypeScript per
  ADR-0033); server row "✅ Working" (item 12).
- `server/README.md` "Phase 2 (planned)" and `product/README.md` Status are stale.
