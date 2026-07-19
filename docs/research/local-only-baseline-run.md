# Local-Only Baseline Run (Issue #164)

Date: 2026-07-19

## Context

Issue #164 (epic #163, a follow-up to the local-only route work merged in PR #162)
asks for the first post-merge experiment: run `factory ship` with
`FACTORY_LOCAL_ONLY=1` and auto-merge disabled against one small open issue,
capture every artifact the run produces, have a Claude Opus reviewer grade the
result, and commit the evidence as a baseline research note plus a scoreboard
row. A parked or failed run is an explicit valid deliverable per the issue — the
point is to replace guessing with a real, evidenced baseline that names the next
harness change.

Machine: `Darwin Patricks-Mac-mini.attlocal.net 25.5.0` (macOS 26.5.2, arm64),
Node v24.14.0.

`ollama list` (abridged to models relevant to `models.json`):

```
NAME                              SIZE
qwen2.5-coder:14b                 9.0 GB
qwen3.5:9b                        6.6 GB
qwen3:8b                          5.2 GB
gemma4:12b                        7.6 GB
```

(Full fleet has 18 models installed; these four are the ones `models.json`
routes to for local-only boss/worker/checker tiers.)

## Preflight

```
$ FACTORY_LOCAL_ONLY=1 node packages/cli/dist/cli.js models --doctor
== Model Doctor ==
  ❌ claude-fable-5 provider=anthropic tier=boss — excluded by FACTORY_LOCAL_ONLY=1
  ❌ claude-opus-4-8 provider=anthropic tier=boss — excluded by FACTORY_LOCAL_ONLY=1
  ❌ claude-sonnet-5 provider=anthropic tier=checker/boss_fallback/worker_fallback — excluded by FACTORY_LOCAL_ONLY=1
  ❌ gpt-5.6-sol provider=openai tier=worker — excluded by FACTORY_LOCAL_ONLY=1
  ❌ gpt-5.1-codex provider=openai tier=worker — excluded by FACTORY_LOCAL_ONLY=1
  ❌ gpt-4.1-mini provider=openai tier=checker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
  ❌ glm-5.2 provider=ollama tier=worker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
  ✅ qwen2.5-coder:14b provider=ollama tier=boss/worker/checker/triage — ok (ollama native)
  ❌ codex-ollama-qwen3.5:9b provider=ollama tier=worker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
  ✅ qwen3.5:9b provider=ollama tier=worker/checker — ok (ollama native)
  ✅ qwen3:8b provider=ollama tier=worker/checker — ok (ollama native)
  ✅ gemma4:12b provider=ollama tier=boss/checker — ok (ollama native)
  ❌ deepseek-v3 provider=deepseek tier=worker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
  ❌ qwen-3.5-coder provider=ollama tier=worker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
  ❌ opencode-sonnet provider=custom tier=worker — experimental — set FACTORY_EXPERIMENTAL=1 to enable
```

Four local Ollama models are reachable and non-experimental
(`qwen2.5-coder:14b`, `qwen3.5:9b`, `qwen3:8b`, `gemma4:12b`) — the doctor
reports a healthy local worker pool. This is important context for the outcome
below: the run did **not** fail for lack of a reachable local model.

## Target issue and why

Per the frozen spec's negotiable fallback: issue #137 (the spec's first choice)
is **CLOSED** (verified 2026-07-19). Of the spec's fallback candidates, **#132**
("Cover the usage-tracking module (83% lines, 50% functions → 100%)") was
confirmed open, non-epic, scoped to one module
(`packages/core/src/usage/index.ts`), with no config/infra/dependency changes,
verifiable by `npm run test`, and no competing open PR
(`gh pr list --search "132 in:title,body"` returned empty). Selected over the
other fallback (#130, constitutions coverage) with no particular preference
between them — #132 was simply checked first and satisfied every criterion.

## Run environment note

The run had to be executed from a fresh clone in a scratch directory
(`/tmp/sf-baseline-164/software-factory`, on `origin/main` at `59bc28a`) rather
than directly in this worktree. `factory ship <n>` creates its per-issue build
worktree as a **sibling directory** of the repo root
(`worktreePathFor` in `packages/cli/src/cli/index.ts`:
`resolve(dirname(repoRoot), ...)`), and this session's sandbox only permits
writes inside the current worktree's own subtree — `git worktree add` at a
sibling path failed with `EPERM`. Separately, `factory init` itself also failed
inside the worktree checkout with `ENOTDIR: not a directory, open
'.../.git/info/exclude'`, because a linked worktree's `.git` is a _file_
(a gitdir pointer), not a directory, and `cmdInit` assumes the latter. Neither
of these is the local-only routing behavior under test, so a clean external
clone (still targeting the real `origin` remote, same commit) was used instead
to isolate the actual experiment from this environment's write restrictions.
Both are recorded as findings below since they are real, reproducible bugs in
the run machinery, independent of local-only routing.

## Run timeline

Command (from the clean `/tmp` clone, auto-merge disabled by construction —
`ship` never invokes `land`/`gh pr merge`):

```
$ FACTORY_LOCAL_ONLY=1 node packages/cli/dist/cli.js ship 132
```

Wall time: 2026-07-19T12:54:17.251Z → 2026-07-19T12:56:33.095Z (**135.8s**).

Models attempted:

- **PLAN**: `qwen2.5-coder:14b`, attempt 1 — succeeded, produced a frozen spec
  at `.factory/plans/issue-132.md` in ~135s.
- **BUILD**: none — zero models were attempted; the router reported
  `No available models for task 'build_codex'` before invoking any harness.

Command observations (from the local-only report and `events.ndjson`):

```
[factory] issue-title #132: Cover the usage-tracking module (83% lines, 50% functions → 100%)
[factory] worktree #132: Worktree ready at /private/tmp/sf-baseline-164/software-factory-factory-ship-it-132
[factory] constitution #132: Standards from repo instruction files
[factory] sandbox-degraded #132: host-level egress filtering unavailable in v1; intended allowlist: api.anthropic.com, github.com
[factory] plan #132: Starting plan phase
[factory] router #132: Trying qwen2.5-coder:14b for plan (attempt 1)
[factory] warn #132: local-only mode requires a local Codex harness — forcing route to codex
[factory] plan #132: Plan complete with model qwen2.5-coder:14b, route: codex
[factory] build #132: Starting build phase (route: codex)
[factory] sandbox #132: containment active (runtime sandbox-exec, net allow-list)
[factory] fail #132: No available models for task 'build_codex'
```

Changed files: **none**. Diff stat vs `origin/main` in the build worktree:
`git diff --stat origin/main` returned empty — no files were touched, the run
never reached a state where it could edit `packages/core/src/usage/index.ts` or
`packages/core/package.json` (the known Codex test-script trap was not
triggered, since BUILD never ran).

Verification/check output: none — the checker framework never ran, since BUILD
failed before producing a patch to check.

Full local-only report
(`.factory/reports/2026-07-19T12-56-33-095Z-issue-132-failed.md`, quoted here
since `.factory/` is not committed):

```markdown
# Local-only run report: issue #132

## Summary

- Outcome: failed
- Profile: local-only
- Route: codex
- Branch: ship-it/132-cover-the-usage-tracking-module
- Worktree: /private/tmp/sf-baseline-164/software-factory-factory-ship-it-132
- Spec: /private/tmp/sf-baseline-164/software-factory/.factory/plans/issue-132.md
- Started: 2026-07-19T12:54:17.250Z
- Reported: 2026-07-19T12:56:33.095Z
- Reason: No available models for task 'build_codex'

## Models Attempted

- qwen2.5-coder:14b for plan, attempt 1

## Changed Files

- No changed files recorded.

## Diff Stat

No diff against origin/main.

## Command Observations

- No command-level observations were captured in the event log.
- This is expected for the current local command-agent spike when it fails before producing a valid action.
- Use the empty-response trace work in #170 to capture raw command-loop detail.

## Verification

- No verification events recorded.

## Failures And Escalations

- fail: No available models for task 'build_codex'
```

## Root cause

`FACTORY_LOCAL_ONLY=1` unconditionally forces the build route to `codex` when
the plan model didn't already choose it
(`packages/core/src/phases/plan.ts:146-152`):

```ts
if (process.env.FACTORY_LOCAL_ONLY === '1' && route !== 'codex') {
  log('warn', 'local-only mode requires a local Codex harness — forcing route to codex');
  route = 'codex';
  ...
}
```

The warn fired in this run (see the event log above), which per the guard
clause means the plan model's own route choice was **not** already `codex` —
the force is what actually set `route: codex` on the persisted spec (the frozen
spec quoted above reflects the post-force value, not the model's original
choice). The `build_codex` task requires a model with capability `codex: true`
(`packages/config/src/routes.json`). Cross-referencing
`packages/config/src/models.json`, exactly three models carry `codex: true`:

- `gpt-5.6-sol` (openai) — excluded by `FACTORY_LOCAL_ONLY=1`
- `gpt-5.1-codex` (openai) — excluded by `FACTORY_LOCAL_ONLY=1`
- `codex-ollama-qwen3.5:9b` (ollama, local) — marked `experimental: true`,
  gated behind `FACTORY_EXPERIMENTAL=1` (not set for this baseline, per the
  issue's instruction to keep defaults)

With `FACTORY_LOCAL_ONLY=1` and no `FACTORY_EXPERIMENTAL=1` — the documented
default posture for local-only — **zero models are eligible for
`build_codex`**. This is not specific to issue #132, the chosen models, or the
local Ollama fleet's health: it is a structural gap that makes every default
local-only run fail deterministically at BUILD, regardless of which issue is
picked. The healthy `models --doctor` output above underscores this: the local
worker pool is fine, but none of those workers carry the one capability the
forced route requires.

## Outcome

**Failed.** No PR was opened (there is nothing to review-only; the run never
produced a diff). No merge commands were run (`ship` never calls `land`/`gh pr
merge` in any case).

The committed scoreboard row (`evals/local-small/baseline-runs.json`) records
`"model": "qwen2.5-coder:14b"`. That is the PLAN model, not a worker model —
BUILD never selected or invoked one, since zero models were eligible for
`build_codex`. It is the only model this run actually exercised, so it is
recorded as the closest honest answer to "model" the schema requires; a reader
of the scoreboard should not infer any worker model was attempted.

## Opus review

Graded via:

```
$ claude --model claude-opus-4-8 -p "<issue #132, the run's diff/failure artifacts, and grading instructions>"
```

**Correctness: 5/10** — of the PLAN output only, since BUILD never ran. The
spec correctly names the target file and the primary 100%-coverage goal and
picks a defensible `codex` route for mechanical test-writing, but it silently
drops the issue's second acceptance clause (raising the ratchet thresholds),
conflates "functions" with specific "line numbers" that read as unverified,
and points at `npm run test:coverage` instead of the repo's actual gate
(`bash scripts/verify.sh`).

**Maintainability: 0/10 (n/a)** — no code was produced to maintain; this is a
structural harness failure, not a code-quality outcome. The failure is fully
deterministic and config-level, so it says nothing about this particular spec.

**Next harness improvements** (Opus's prioritized list):

1. **(P1 — the actual unblock)** Un-gate local codex-capable models under
   local-only: in the model-eligibility filter driving `build_codex` selection,
   make a model eligible if `experimental !== true` **or**
   (`FACTORY_LOCAL_ONLY === '1'` and the model is local and `codex: true`).
   This alone would have let this run reach BUILD with
   `codex-ollama-qwen3.5:9b`.
2. **(P2 — fail fast)** Add a preflight eligibility check at
   `plan.ts:146-152`'s route-force site: before committing to `route =
'codex'`, verify at least one model is eligible for `build_codex` under the
   current env flags, and fail in PLAN with an actionable message instead of
   spending ~135s planning only to die one line into BUILD.
3. **(P3 — reconsider the forced target)** The premise "local-only mode
   requires a local Codex harness" is false under defaults — no such harness is
   eligible. The local Ollama fleet is capable of mechanical test-writing;
   consider forcing a local non-codex build route (e.g. a `build_local` route
   resolving to the available Ollama models) instead of `codex`, which doesn't
   depend on the experimental codex-over-Ollama shim working.
4. **(P4 — regression guard)** Add a config-consistency test asserting every
   route in `routes.json` has ≥1 eligible model under the documented default
   local-only posture (`FACTORY_LOCAL_ONLY=1`, `FACTORY_EXPERIMENTAL` unset).
   This would have caught the dead route before any live run.
5. **(P5 — plan quality, secondary)** Tighten the PLAN prompt to require the
   spec to address every acceptance-criteria bullet explicitly (and point the
   "Tests" section at `scripts/verify.sh`), so once #1–#3 unblock BUILD, the
   result is acceptance-complete.

## Next harness change (top recommendation for epic #163)

**Make `codex-ollama-qwen3.5:9b` (or an equivalent local codex-capable worker)
eligible for `build_codex` when `FACTORY_LOCAL_ONLY=1` is set, even without
`FACTORY_EXPERIMENTAL=1`.** Today the combination of "local-only forces
`route=codex`" (`packages/core/src/phases/plan.ts:146-152`) and "the only local
`codex: true` model is `experimental`-gated"
(`packages/config/src/models.json`) means local-only mode cannot reach BUILD
for any issue by default — the mode is currently unusable outside of also
setting the experimental flag. Fixing model eligibility (or, as a fallback,
changing the forced route to a non-codex local path per Opus's P3) is the
single change that turns this baseline from "structural dead end" into "a real
local-only BUILD attempt," which is the prerequisite for every other local-small
harness experiment epic #163 wants to run next.

## Secondary findings (environment, not routing)

- `factory init` throws `ENOTDIR` when run inside a linked git worktree, because
  it assumes `.git` is a directory (`repoRoot/.git/info/exclude`) rather than
  handling the gitdir-pointer file linked worktrees use. Worth a defensive fix
  (e.g. resolving the exclude file via `git rev-parse --git-path
info/exclude`) so factory tooling works uniformly whether run from a primary
  checkout or a worktree.
- `worktreePathFor` (`packages/cli/src/cli/index.ts:953-955`) always places the
  per-issue build worktree as a sibling of the repo root, with no override. The
  `worktree.prefix`/`worktree.parent` keys already exist in the `factory.json`
  schema and are parsed by `loadFactoryConfig`, but are never consumed by
  `worktreePathFor` or any other call site — they are dead config. Wiring
  `worktree.parent` through would let sandboxed/CI environments (where only a
  subtree is writable) redirect the worktree location without code changes.
