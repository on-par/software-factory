# Software Factory: bash `factory` vs. the TypeScript monorepo

_Analysis date: 2026-07-10_

A comparison of the two implementations of the software factory, and a recommendation for turning it into a productized / open-source project.

- **A — the installed tool:** `~/.local/bin/factory` (668-line single-file bash, `v` unversioned). This is the **battle-tested, in-production** tool. The repo preserves a copy at `legacy/bin/factory`.
- **B — this repo:** `@on-par/software-factory` v2.0.0 — an npm-workspaces TypeScript rewrite (`packages/{config,core,cli,server}`). Compiles clean (`npm run typecheck` passes across all 4 packages). This is an **ambitious re-architecture that is roughly 40% wired up.**

---

## TL;DR verdict

**The bash tool is the working product. The TS repo is the better architecture — but it is not yet a working product, and in a few places it silently regresses on safety.**

The right productization move is **not** "finish the rewrite" or "ship the bash script." It's a **merge**: keep the TS repo's genuinely novel ideas (config-driven multi-provider routing, per-product *constitutions*, an independent *checker* framework with a rework loop) and **port back the operational core that the bash version already got right** (git/merge locking, `land`, `supervise`/usage-watchdog, self-heal). Right now those two halves live in two different languages and neither file has both.

---

## What each one actually is

### A. bash `factory` — an operations-hardened pipeline runner

A single script that shells out to `claude -p` and `codex exec`. It owns very little "intelligence" itself — it leans on the existing `/ship-it` skill and the codex-first routing heuristic — but it owns the **operational envelope** completely:

- **Pipeline:** PLAN (Opus freezes a spec + picks a route) → BUILD (`codex exec --yolo` **or** `claude /ship-it`) → FINISH (Claude reviews Codex's commit, runs verify/review, opens PR).
- **Concurrency model that actually works:** lanes run in parallel; issues within a lane run serially; **all worktree/branch ops on the shared `.git` are serialized through `GIT_LOCK`**, and merges through `MERGE_LOCK`.
- **`land`:** rebase-if-DIRTY → squash-merge → delete branch → prune worktree.
- **`supervise`:** subscription-usage-aware multi-window loop — a Python cost-estimator reads local Claude Code transcripts, computes trailing-5h cost-weighted spend vs a calibrated cap, **stops lanes near the cap and resumes when usage drains.** This is what makes it safe to leave running for days on a Max plan.
- **Self-healing `recover_pr`:** if a worker dies after committing but before opening the PR, the factory pushes the branch and opens the PR itself.
- **`ESCALATE:` protocol, `STOP`/`resume`, structured `events.ndjson`, per-issue timeouts, explicit error codes.**

### B. TS monorepo — a config-driven, typed, extensible engine

Same PLAN → BUILD skeleton, re-expressed as a typed library plus three new subsystems the bash version has no concept of:

| Package | Role |
|---|---|
| `@on-par/factory-config` | Zero-dep. `models.json`, `routes.json`, `factory.json` + constitution markdown. |
| `@on-par/factory-core` | The engine: `ModelRegistry`, `ModelRouter` (failover), `ConstitutionLoader`, checker framework, PLAN/BUILD/CHECK/SHIP phases. |
| `@on-par/factory-cli` | The `factory` command (commander/chalk). |
| `@on-par/factory-server` | **Stub.** `createServer()` throws "not yet implemented". |

---

## Feature parity matrix

| Capability | bash `factory` | TS monorepo | Notes |
|---|:---:|:---:|---|
| PLAN phase (freeze spec, pick route) | ✅ | ✅ | Near-identical prompts |
| BUILD via Codex CLI | ✅ | ✅ | TS loses `-C` worktree flag nuance & per-run effort override |
| BUILD via Claude `/ship-it` | ✅ | ✅ | |
| FINISH pass (review Codex's diff) | ✅ | ⚠️ | bash has a dedicated FINISH prompt; TS folds it into CHECK |
| Route fallback codex→claude when codex absent | ✅ | ⚠️ | bash explicit; TS relies on registry availability |
| Lane parallelism + serial-within-lane | ✅ | ✅ | |
| **`.git` lock serialization** | ✅ | ❌ | **TS runs `setupWorktree` on concurrent lanes with no lock** |
| **Merge serialization (`MERGE_LOCK`)** | ✅ | ❌ | |
| **`land` / squash-merge / rebase-on-dirty** | ✅ | ❌ | TS `waitForMerge`: "auto-merge not yet implemented" |
| **`supervise` (multi-window usage loop)** | ✅ | ❌ | Entire subsystem absent |
| **`usage` (trailing-5h cost cap)** | ✅ | ❌ | Absent (there is a per-task `cost` report instead) |
| **Self-heal `recover_pr`** | ✅ | ❌ | Absent |
| `STOP` / `resume` | ✅ | ✅ | |
| `ESCALATE:` protocol | ✅ | ✅ | |
| Triage → human-reviewed `.proposed` | ✅ | ⚠️ | TS writes queue directly, no `.proposed` staging |
| **Multi-provider model routing + failover** | ❌ | ✅ | anthropic/openai/ollama/deepseek, tiered, retry+cooldown |
| **Per-product constitutions** | ❌ | ✅ | Written standard injected into every phase |
| **Independent checker framework** | ⚠️ | ✅ | bash had checker *stubs* in `legacy/lib/checkers`; TS makes it real |
| **CHECK rework loop (≤3 rounds) + dispute resolution** | ❌ | ✅ | Boss arbitrates worker-vs-checker via constitution |
| **Cost tracking per task/model** | ❌ | ✅ | `factory cost` |
| Typed, unit-testable, packaged | ❌ | ✅ | |
| SaaS server | ❌ | 🟡 stub | |
| **Actually run end-to-end unattended today** | ✅ | ❌ | TS can't merge, can't self-supervise, can corrupt `.git` |

Legend: ✅ present · ⚠️ partial/weaker · 🟡 stub · ❌ absent

---

## What the TS rewrite genuinely adds (this is the OSS story)

These are the reasons to invest in the TS line rather than just polishing bash. None of them exist in the bash tool:

1. **Constitutions.** A per-product markdown "written standard + how to check it" (`packages/config/src/constitutions/*.md`), injected into PLAN, BUILD, and CHECK, and referenced by checkers. This is the differentiated idea — it reframes the prompt from *instructions* to *standard + verifier*. Great OSS hook.
2. **Config-driven multi-provider routing** (`models.json` + `routes.json`). Task-type → tier → first-available-model, with a real failover state machine (rate-limit retry+cooldown, usage-cap failover, timeout failover). Lets users bring cheap local (Ollama) or third-party (DeepSeek) models for bulk work and reserve Opus for planning. The bash tool is Anthropic+Codex only.
3. **Independent checker framework with a rework loop.** `compile / tests / lint / links / accessibility` built-ins plus agent-based `custom_*` checkers pulled from the constitution, a ≤3-round rework loop, and boss-arbitrated dispute resolution. This is a real quality gate the bash tool delegates entirely to `/ship-it`.
4. **A clean seam for a SaaS product.** `core` is deliberately UI-less so a webhook server or a hosted control plane can consume it. The bash tool cannot be a library.

---

## What the rewrite dropped or broke (the gap to a shippable product)

The rewrite ported the *happy path* and left out the *operational hardening* — which is exactly the part that took the bash tool from "demo" to "runs for days unattended." Concrete issues:

### Correctness / safety bugs in the current TS code

1. **No `.git` lock — concurrent worktree setup can corrupt the repo.** `cmdRun` fires every lane's `cmdShip` in parallel, and `cmdShip` calls `gitFetch` + `setupWorktree` on the **shared** repo with no serialization. The bash version wraps every such op in `with_lock "$GIT_LOCK"` precisely because parallel `git worktree add`/`branch -D` on one `.git` race. `packages/cli/src/cli/index.ts:233`.
2. **`waitForMerge` cannot actually detect its own merge.** It hard-codes `branch = "ship-it/${issue}-"` with a `// simplified` comment, never uses it, and instead scans the **last 5 closed PRs** for `Closes #N`. On a busy repo the merge falls off that window and the lane blocks forever. `packages/cli/src/cli/index.ts:364`.
3. **`FACTORY_MERGE=1` is a no-op.** It logs "auto-merge not yet implemented" and returns. So the TS tool **cannot close the loop** — every issue parks at a PR waiting for a human, with no `land`. `index.ts:383`.
4. **No usage governor.** Nothing stops the TS factory from burning through a subscription window. The bash `supervise`/`usage` watchdog — the single most important feature for unattended Max-plan operation — has no equivalent.
5. **No self-heal.** If a worker commits then dies, the TS pipeline fails the issue; bash recovers it.
6. **Speculative model registry.** `models.json` lists `gpt-5.5`, `glm-5.2`, `qwen-3.5-coder`, `deepseek-v3` with invented costs/flags and **zero tests**. The failover state machine is plausible but entirely unproven end-to-end.
7. **Zero tests anywhere.** Every package's `test` script is `echo 'no tests yet'`. For a tool that runs `--dangerously-skip-permissions` and `codex --yolo` unattended, that's the headline risk.

### Design regressions

- Triage writes the live queue directly instead of a human-reviewed `.proposed` (bash deliberately stages it).
- The FINISH-vs-CHECK split means the TS version reviews Codex's diff with *built-in* checkers rather than the richer `/ship-it` + `/code-review` + `/security-review` pass the bash FINISH prompt invokes.

---

## Recommendation: productize by merging the two, TS as the base

**Adopt the TS monorepo as the home, and port the bash tool's operational core into `core` before adding anything new.** Concretely, three tracks:

### Track 1 — Close the correctness gap (make TS match bash; ~1–2 wk)
Non-negotiable before this is safe to run or ship as OSS:
1. Port `GIT_LOCK` / `MERGE_LOCK` serialization into an `orchestrator` module (a promise-mutex around worktree + merge ops).
2. Implement real `land`: rebase-on-DIRTY, `gh pr merge --squash --delete-branch`, worktree prune. Wire `FACTORY_MERGE`.
3. Fix `waitForMerge` to track the real branch name and query by head, not a 5-PR scan.
4. Port `supervise` + the usage-watchdog cost estimator (reuse the existing Python, or reimplement in TS reading the same transcripts).
5. Port `recover_pr` self-heal.
6. Add an integration test that runs the whole pipeline against a throwaway repo with a stub "model" (an echo script), so the orchestration is tested without spending tokens.

### Track 2 — Make the novel ideas real & documented (the OSS differentiator)
1. Ship 2–3 **example constitutions** + a `constitution --init` scaffolder; document the "standard + checker" model prominently — it's the project's identity.
2. Prune `models.json` to models that actually exist and are tested; mark the rest `experimental`. Add a `factory models --doctor` that probes which providers are reachable.
3. Unit-test the router failover state machine and the checker JSON parsing (both are brittle string-matching today).

### Track 3 — OSS packaging
1. **Name & scope.** `@on-par/*` is a personal scope; pick a neutral public name and MIT-license the whole thing (LICENSE already present).
2. **`README` = 5-minute quickstart** on a real public repo, plus an honest "what works / what's experimental" table (Codex, Ollama, merge, supervise).
3. **`npx <tool> init`** with zero global install; publish `cli` + `core` + `config`, keep `server` out of the first release.
4. **Safety front-and-center:** document that it runs `--dangerously-skip-permissions` / `codex --yolo` in isolated worktrees, and default to review-mode (park at PR) exactly like bash.
5. Delete or clearly quarantine the `server` stub for v1 — a stub that throws in a published package is a bad first impression.

### What to explicitly NOT do first
- Don't build the SaaS server yet. The unattended-CLI story is the wedge; the hosted product only makes sense once `core` is proven and merge/supervise work.
- Don't expand the model matrix further until the existing chain is tested.

---

## One-paragraph summary for a stakeholder

We have two software factories. The **bash** one works and runs unattended today, but it's a single 668-line script that can't grow into a product. The **TypeScript** one has the architecture a product needs — config-driven multi-model routing, per-product "constitutions," and an independent checker/rework loop that are genuinely novel — but it's about 40% wired: it **can't merge PRs, can't govern its own usage, and can race the git repo under parallel lanes.** The play is to make the TS repo the base, spend ~1–2 weeks porting the bash tool's proven operational core (locking, `land`, `supervise`, self-heal) and adding the first real tests, then package `cli`+`core`+`config` as an MIT OSS tool whose headline is "constitution-governed, multi-model, self-verifying issue-to-PR factory." The SaaS server waits until that core is proven.
