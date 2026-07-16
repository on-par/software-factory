# Small-Model Factory Harness

Date: 2026-07-13

## Question

Can the Software Factory produce reliable issue-to-PR results with small local
models by changing the harness, rather than expecting every model to behave like
Codex, Claude, or another full agent?

## Short Answer

Yes, but the winning design is not "point Codex at Ollama and hope the local
model uses tools." The factory needs a model-size-adaptive execution harness.
For small models, the harness should own decomposition, context selection,
command execution, patch application, verification, retries, and escalation. The
model should be asked to make one narrow decision at a time: plan a step, choose
files to inspect, propose a patch, explain a failing check, or pick the next
step.

That moves hard agent behavior out of the model and into deterministic TypeScript
code. Bigger models can still use the existing larger-grained boss/worker/checker
path, but smaller models get a stepwise path optimized for short context,
bounded edits, and tight feedback loops.

## Current Repo Findings

The repository already has the right foundation:

- `packages/config/src/models.json` defines provider models, costs, tiers,
  context windows, and local Ollama model entries.
- `packages/config/src/routes.json` maps task types to model tiers and can grow
  new task types such as `step_plan`, `step_patch`, and `step_repair`.
- `packages/core/src/phases/plan.ts` already separates PLAN from BUILD and writes
  a frozen spec.
- `packages/core/src/phases/build.ts` now has a `FACTORY_LOCAL_ONLY=1` compact
  prompt path, but it still asks the worker to complete an implementation pass.
- `packages/core/src/router/index.ts` now has native Ollama API support and a
  command-loop worker for Ollama-backed Codex models.
- `packages/core/src/checkers/index.ts` already runs deterministic build, test,
  lint, link, accessibility, and custom checker gates.
- `packages/core/src/eval/runner.ts` already has a deterministic eval runner that
  can become the bakeoff harness for local-small profiles.

Wiring quirks found while reading the `feat/local-only-ollama-factory` branch
(e4a0e5f):

- `codex-ollama-qwen3.5:9b` carries
  `codexFlag: "--oss --local-provider ollama -m qwen3.5:9b"`, but the router
  dispatch (`def.codex && def.provider === 'ollama'` →
  `runOllamaCommandAgent`) intercepts it **before** `runCodex()` — the flag is
  dead config today. The flags themselves are real (`codex-cli 0.144.3`
  documents `--oss` and `--local-provider <lmstudio|ollama>`).
- `planPhase` (`packages/core/src/phases/plan.ts`) only persists the model's
  output **if the spec file does not already exist** ("The Claude output might
  BE the spec content"). With a pre-existing spec, the plan model's work is
  silently discarded and the stale spec reused.
- The native Ollama path is chat-only — the model has no file or repo access —
  yet the PLAN prompt asks it to "explore the codebase" and write a file at
  `${specPath}`. A chat-only model can do neither.

## Why the Previous Local-Only Attempt Failed

The comparison run on issue #137 (`compare-local/137…` worktree) died in
BUILD. From `.factory/events.ndjson` (2026-07-13, 19:31–19:46 Z):

```text
19:31 plan complete with qwen2.5-coder:14b, route: codex
19:33 codex-ollama-qwen2.5-coder:14b failed (empty_response) on build_codex
19:35 (rerun) plan complete with qwen2.5-coder:14b, route: codex
19:40 codex-ollama-qwen3.5:9b failed (error) on build_codex (attempt 1)
19:46 codex-ollama-qwen3.5:9b failed (error) on build_codex (attempt 2)
19:46 FAIL: All models failed for task 'build_codex'
```

Root causes, in order of importance:

1. **The PLAN "success" was an illusion.** `.factory/plans/issue-137.md`
   (mtime 14:26 CDT) predates both local runs (14:31 and 14:35 CDT) — it is
   the detailed spec frozen by the earlier Claude-driven `ship-it/137` run.
   Because `planPhase` only writes output when no spec exists, the local
   model's 52-second chat reply was thrown away and the stale Claude spec was
   reused. The local pipeline never actually demonstrated local planning.
2. **The command loop treats any failing command as a fatal attempt error.**
   Commands run through `execFn`, which throws on non-zero exit; the throw
   propagates out of `runOllamaCommandAgent`, the router classifies it as
   `error`, retries once, then kills the model. For an agent loop this is
   backwards — a failing command (file not found, grep no-match, failing
   test) is the most valuable _observation_ to feed back, not a crash. This
   is the direct mechanism behind both `(error)` failures.
3. **`empty_response` = format non-compliance.** When the model's first turn
   contains neither parseable JSON nor a bash fence, `parseLocalAgentAction`
   returns no commands and the executor throws `empty_response`. Nothing
   constrains decoding — the JSON contract lives only in prose inside the
   prompt, the weakest possible enforcement for a 9B model.
4. **No context accounting.** The worker prompt = compacted spec (≤6,000
   chars) + rules + growing tails of command output, re-sent as one flat user
   message every turn against `num_ctx: 8192`. Ollama silently truncates the
   _front_ of an over-long prompt — exactly where the spec sits.
5. **Wrong task granularity.** The frozen #137 spec is a ~60-line multi-
   section document with an embedded verification protocol. Small models
   reliably execute one bounded step with its context in hand; they do not
   reliably orchestrate "read this essay, plan edits, drive shell,
   self-verify, commit" in one pass. The command loop was a useful experiment,
   but it is too command-oriented and too unconstrained.
6. **Environment fragility** (secondary): Ollama.app can start before
   `OLLAMA_MODELS=/Volumes/T7 Shield/Ollama/Models` is set, so `ollama list`
   comes up empty; `ECONNREFUSED 127.0.0.1:11434` during restarts. The doctor
   now probes for this, but the run path has no preflight.

## External Findings

Ollama's native API gives us the primitives needed for a better harness:

- `/api/chat` accepts `messages`, optional `tools`, `format`, `options`,
  `stream: false`, and `keep_alive`. This lets the factory request JSON/schema
  output and keep the active local model warm between step calls.
  Source: https://github.com/ollama/ollama/blob/main/docs/api.md
- Ollama supports structured output by passing a JSON schema in `format`, and its
  docs warn that JSON mode should be paired with prompt instructions that require
  JSON.
  Source: https://github.com/ollama/ollama/blob/main/docs/api.md
- Ollama exposes model loading and unloading through empty requests plus
  `keep_alive`. On a 16 GB Mac, the factory should keep at most one coding model
  loaded for the local-small profile and unload role-switched models aggressively.
  Source: https://github.com/ollama/ollama/blob/main/docs/faq.mdx
- Ollama queues requests when memory is insufficient and concurrent requests
  increase memory pressure. This argues for local-small concurrency of one and
  against subagent fanout on 16 GB RAM.
  Source: https://github.com/ollama/ollama/blob/main/docs/faq.mdx
- The Codex CLI installed here supports `codex exec --oss --local-provider
ollama -m <model>`, but local models still need a harness that they can actually
  follow. The CLI option proves connectivity, not tool-use reliability.
  Source: local `codex exec --help`, observed 2026-07-13.
- SWE-agent's paper argues that agent-computer interface design materially
  changes coding-agent performance. This matches our failure: the same small
  model becomes more useful when the interface is a narrow, designed workflow
  instead of a free-form terminal session.
  Source: https://arxiv.org/abs/2405.15793
- SWE-bench frames real issue resolution as requiring execution environments,
  long-context handling, and multi-file coordination. Small local models will not
  win by doing all of that internally; the harness must provide the environment,
  context reduction, and verification loop.
  Source: https://arxiv.org/abs/2310.06770
- Aider maintains per-model "edit formats" precisely because weaker models fail
  free-form editing: whole-file for the weakest, SEARCH/REPLACE blocks for most,
  simplified unified diffs for lazy-coding models, plus an architect/editor split
  that separates deciding the change from formatting the edit. This is the
  closest production-proven precedent for the stepwise harness below.
  Source: https://aider.chat/docs/more/edit-formats.html
- Ollama's chat endpoint reports `prompt_eval_count` on every non-streamed
  response; the harness should read it to enforce the context budget and fail
  loudly instead of letting Ollama truncate silently.
  Source: https://github.com/ollama/ollama/blob/main/docs/api.md

## Proposed Architecture

Add a second execution profile alongside the current boss/worker/checker flow:

- `workhorse`: current large-model path. Larger prompts, larger chunks, richer
  agent autonomy.
- `local-small`: deterministic, stepwise path. One local model at a time, small
  prompts, bounded edits, cheap verification after every step.

The key abstraction is a `StepwiseHarness`, not another prompt variant.

```text
issue -> frozen spec -> step plan -> context pack -> patch proposal
      -> apply/verify -> repair or next step -> final check -> PR
```

## Runtime Adapters, Not Codex Lock-In

The local-small design should not depend on the Codex harness. Codex should be
one runtime adapter among several. The factory's durable abstraction should be:

```text
Factory profile -> StepwiseHarness -> ModelRuntimeAdapter -> provider/tool
```

Suggested adapters:

- `NativeOllamaAdapter`: direct `/api/chat` calls with `format` JSON schema,
  `options`, and `keep_alive`. This is the most controllable path and should be
  the first production local-small target.
- `CodexAdapter`: current `codex exec` path, including
  `--oss --local-provider ollama` for experiments. Useful, but not the core
  local contract because small local models do not reliably use Codex tools.
- `ClaudeCodeOllamaAdapter`: `ollama launch claude` / Ollama's
  Anthropic-compatible API. Good for a workhorse-style external agent runtime
  when it behaves well with a specific local model.
- `OpenCodeAdapter`: OpenCode supports many providers and local models, so it is
  worth a bakeoff path. Treat it as an external agent runtime with observable
  inputs/outputs, not as the factory's internal control plane.
- `PiAdapter`: Pi is promising because it is explicitly an agent harness with a
  unified multi-provider model layer and local-provider config. It is worth
  evaluating as a provider/runtime bridge, especially if its tool loop is more
  reliable with local models than Codex/OpenCode.

The factory should use these adapters behind one interface:

```ts
interface ModelRuntimeAdapter {
  completeJson<T>(request: JsonModelRequest<T>): Promise<T>;
  proposePatch(request: PatchRequest): Promise<PatchProposal>;
  runAgent?(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

For `local-small`, prefer `completeJson()` and `proposePatch()` over
`runAgent()`. For `workhorse`, allow `runAgent()` because larger models and
agent runtimes can handle bigger chunks.

### New Core Modules

`TaskSizer`
: Reads the issue/spec and classifies work by estimated complexity: files
touched, test surface, design ambiguity, and maximum safe step size. Emits a
profile recommendation: `local-small`, `workhorse`, or `escalate`.

`StepPlan`
: A structured artifact committed to the worktree or temp dir. It contains tiny
deliverable steps, acceptance criteria per step, expected files, verification
command, and escalation conditions. This is the Markdown/JSON bridge Patrick
described.

`ContextPackBuilder`
: Deterministically builds the prompt context for one step. It should use repo
search, file excerpts, test snippets, package scripts, and git diff. It should
not dump the full issue, full spec, and full constitution on every turn.

`PatchProposer`
: Calls the model with a JSON schema and asks for either:

- `inspect`: requested files/searches
- `patch`: a unified diff
- `done`: step complete
- `escalate`: specific blocker

`PatchApplier`
: Validates and applies unified diffs. Enforces max files, max lines, allowed
paths, no lockfile churn unless requested, and no unrelated files. This is
safer than letting small models issue arbitrary shell edits.

`StepVerifier`
: Runs the cheapest relevant command after each step. Uses deterministic checks
first. If verification fails, captures only the useful failure excerpt for a
repair prompt.

`RepairLoop`
: Allows one or two repair attempts per step. If repair fails, shrink the step,
replan, or escalate to a larger profile.

`ModelProfile`
: Encodes prompt budget, max touched files, max patch lines, allowed action
types, retry count, Ollama keep-alive policy, and concurrency.

## Local-Small Profile

Recommended first profile for a 16 GB M4 Mac Mini:

```json
{
  "name": "local-small",
  "concurrency": 1,
  "planner": "qwen2.5-coder:14b",
  "worker": "qwen3.5:9b",
  "checker": "qwen3.5:9b",
  "embedder": "nomic-embed-text:latest",
  "maxContextChars": 12000,
  "maxFilesPerStep": 2,
  "maxPatchLinesPerStep": 120,
  "maxRepairAttempts": 2,
  "preferredOutput": "json-schema",
  "editMode": "unified-diff",
  "ollamaKeepAlive": "10m"
}
```

Notes:

- `qwen2.5-coder:14b` should be tried as the planner because it already showed
  planning ability in the failed run.
- `qwen3.5:9b` should be tried as the worker/checker because it is lighter and
  should fit the single-step patch role better than full-agent work.
- Avoid `glm-5.2:cloud` in this profile. It goes through Ollama but is not
  local-only.
- Keep concurrency at one. On this hardware, subagents should be orchestration
  concepts, not simultaneously loaded local models.

## Task Types to Add

Extend `TaskType` and `routes.json` with small-model-specific tasks:

- `size_task`: classify issue/spec for profile selection.
- `plan_steps`: produce the step plan artifact.
- `select_context`: ask for missing context only when deterministic search is
  insufficient.
- `propose_patch`: return one unified diff for one step.
- `repair_patch`: fix one failing check from a compact failure excerpt.
- `review_step`: review only the current step diff against its acceptance
  criteria.
- `summarize_progress`: compact state after each step so later prompts stay
  short.

This avoids overloading `build_codex` with incompatible execution styles.

## Prompt Shape

Small-model prompts should be short and schema-bound:

```text
ROLE: patch proposer
STEP: <one step>
ACCEPTANCE: <2-5 bullets>
FILES: <short excerpts only>
CURRENT DIFF: <small diff or none>
VERIFY COMMAND: <one command>

Return JSON matching this schema:
{
  "action": "inspect|patch|done|escalate",
  "paths": ["..."],
  "patch": "<unified diff or empty>",
  "reason": "<short>"
}
```

The harness should reject malformed output, ask once for corrected JSON, then
fail over or shrink the task. Do not let malformed output flow into shell
execution.

## Implementation Plan

0. Fix the correctness bugs on the current branch first — they invalidate any
   future comparison run:
   - `planPhase` must never silently reuse a stale spec: if `specPath` exists
     and predates the run, archive it and write the fresh output; log which
     spec was used (`packages/core/src/phases/plan.ts`).
   - `runOllamaCommandAgent` (until replaced): catch non-zero exits and feed
     `exit code + stderr` back as an observation instead of throwing; gate the
     unconditional `git add -A && git commit` fallback behind a diff sanity
     check (`packages/core/src/router/index.ts`).
1. Add `profiles.json` or extend `factory.json` with `workhorse` and
   `local-small` execution profiles.
2. Add new `TaskType` entries and route mappings for the stepwise tasks.
3. Add `packages/core/src/stepwise/` with `TaskSizer`, `StepPlan`,
   `ContextPackBuilder`, `PatchApplier`, `StepVerifier`, and `StepwiseHarness`.
4. Add native Ollama structured-output support in `CliModelExecutor.callOllama`
   by allowing per-task `format`, `keep_alive`, and a JSON schema.
5. Prefer unified-diff patch application over shell commands in local-small mode.
   Keep the existing command loop as a fallback or debugging tool.
6. Add a CLI flag/env pair:
   - `FACTORY_PROFILE=local-small`
   - `factory ship <issue> --profile local-small`
7. Add local-small eval cases to the existing eval runner:
   - plan can be parsed
   - patch applies
   - changed files stay within budget
   - targeted verification passes
   - final diff satisfies acceptance criteria
8. Re-run issue #137 with `--no-auto-merge` and compare against a Codex
   workhorse PR. Delete or archive the stale `.factory/plans/issue-137.md`
   first so the local planner is actually exercised (see failure analysis
   above).

## Success Criteria

The first milestone should not be "small model solves every issue." It should be:

- For a simple docs/DX issue, local-small creates a PR without cloud inference.
- The run uses only local Ollama models and deterministic shell commands.
- Every model response is schema-validated.
- The factory can resume from the step plan after a failed step.
- The final diff is smaller and more focused than the previous free-form
  command-loop attempt.
- The same issue can be run under `workhorse` for PR-to-PR comparison.

## Risks

- Some small models will still emit malformed JSON. Mitigation: schema retry,
  smaller prompts, and model-specific output adapters.
- Unified diffs from small models may fail to apply. Mitigation: include exact
  file excerpts with line anchors and allow one repair prompt.
- Step plans may be too vague. Mitigation: deterministic task sizer rejects
  vague steps before execution.
- Local model switching may thrash memory. Mitigation: one model loaded at a
  time, `keep_alive` tuned per profile, and explicit unload before role changes.

## Recommendation

Build the local-small harness as a first-class execution profile. Do not keep
adding special cases to the current BUILD prompt. The long-term product story is
stronger if the Software Factory can say:

> Larger models increase chunk size and quality, but the harness itself makes
> progress reliable by decomposing work, constraining edits, verifying every
> step, and escalating only when needed.

That is the route to making model size an optimization parameter instead of a
hard dependency.

## Evidence & Sources

- Repo code: `packages/core/src/router/index.ts` (native Ollama executor,
  `runOllamaCommandAgent`, `parseLocalAgentAction`, failover classification),
  `packages/core/src/phases/{plan,build,check}.ts`,
  `packages/core/src/models/index.ts` (`isLocalOnlyModel`, doctor probes),
  `packages/config/src/{models,routes}.json`, `FACTORY_COMPARISON.md`; branch
  diff `main...feat/local-only-ollama-factory` (e4a0e5f).
- Run evidence: `.factory/events.ndjson` (issue 137,
  2026-07-13T19:31–19:46Z); `.factory/plans/issue-137.md` (mtime 14:26 CDT,
  predating both local runs); `git worktree list`
  (`…-factory-compare-local-137`).
- Host verification (2026-07-13): `ollama list` confirms `qwen2.5-coder:14b`,
  `qwen3.5:9b`, `qwen3:8b`, `gemma4:12b`, `nomic-embed-text:latest` present;
  `codex-cli 0.144.3 --help` confirms `--oss` / `--local-provider`.
- Session notes: `~/.openclaw/workspace-beckett/memory/2026-07-13.md` and
  `2026-07-13-1401.md` (16 GB tuning guidance; T7 `OLLAMA_MODELS`
  startup-order issue).
- Ollama API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
  (moving to https://docs.ollama.com/api).
- Ollama launch / Claude Code integration:
  https://ollama.com/blog/launch and
  https://docs.ollama.com/integrations/claude-code
- OpenCode providers: https://opencode.ai/docs/providers/
- Pi provider/model configuration: https://pi.dev/ and
  https://pi.dev/docs/latest/models
- Aider edit formats: https://aider.chat/docs/more/edit-formats.html
- SWE-agent ACI: https://arxiv.org/abs/2405.15793 ·
  SWE-bench: https://arxiv.org/abs/2310.06770
