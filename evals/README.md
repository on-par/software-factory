# Eval Golden Cases

Each `evals/golden/*.md` file is one issue-shaped prompt fixture.
Frontmatter may set `id`, `expectedRoute`, `deterministicOnly`, `rubric`, and `minRubricScore`.
When `constitution:` is set, the runner injects it as the prompt constitution context and the deterministic scorer requires a `## Constitution compliance` section.
Failure replays may also use documentary `replay:` and `sourceIssue:` markers for never-retire cases.
The first `# ` heading becomes the issue title.
All markdown after that heading becomes the issue body.
Use `expectedRoute: any` when only spec structure matters.
Use `deterministicOnly: true` to skip the LLM judge even in real mode.
Add rubric items only for cases that need qualitative scoring.
For offline runs, include a fenced `stub-output` block with the canned PLAN output.
Run `npm run eval -- --stub` before committing prompt, skill, constitution, or
golden-set changes. CI also runs the stub subset on every PR, so a broken prompt
or golden case fails the PR check at zero model cost.

## Local-small first green

The canonical first-green local-small yardstick is `local-small-first-green`.
It is intentionally a tiny docs-only issue with an exact expected diff and one
cheap verification command, so failures point at harness or model behavior
rather than task ambiguity.

Run only that case with:

```
npm run eval -- --stub --filter local-small-first-green --no-judge
```

## Local-small scoreboard

The local-small scoreboard is file-based and can run without cloud credentials.
Collect one JSON row per model/scenario run:

```json
{
  "runs": [
    {
      "scenario": "local-small-first-green",
      "runtime": "local-small",
      "model": "qwen2.5-coder:7b",
      "patchApplied": true,
      "testsPassed": true,
      "diffSize": 5,
      "repairCount": 0,
      "durationMs": 900,
      "reviewerGrade": 9
    }
  ]
}
```

Render Markdown locally:

```
npm run local-small-scoreboard -- --input runs.json --output scoreboard.md
```

Compare against a previous baseline:

```
npm run local-small-scoreboard -- --input runs.json --baseline baseline-runs.json
```

The committed baseline input for `--baseline` is
[`evals/local-small/baseline-runs.json`](local-small/baseline-runs.json) — see
`docs/research/local-only-baseline-run.md` for the run it records.

## Weekly prompt regression eval run

The `Weekly Prompt Evals` workflow (`.github/workflows/nightly-evals.yml`) runs
the full scored suite weekly and on `workflow_dispatch`. This is a prompt,
system-prompt, skill, and constitution regression signal, not a model bakeoff:
the workflow pins the plan model and judge model so model choice stays stable
while prompt behavior changes are measured.

The weekly run uses real LLM calls, compares the results against the committed
baseline at `evals/baseline.json`, and fails the job if any case regresses beyond
its tolerance. The run report is always uploaded as a build artifact, even on
failure.

The workflow authenticates the Claude CLI with the `CLAUDE_CODE_OAUTH_TOKEN`
repo secret (a Claude subscription token from `claude setup-token`) or, if set
instead, `ANTHROPIC_API_KEY` (API billing). The preflight step fails when
neither is configured.

Run the same pinned real eval locally:

```
npm run eval -- --judge-k 3 --plan-model claude-fable-5 --judge-model claude-sonnet-5-5 --report eval-report.json --baseline evals/baseline.json
```

Refresh the baseline after an intentional prompt or golden-set change:

```
npm run eval -- --plan-model claude-fable-5 --judge-model claude-sonnet-5-5 --write-baseline evals/baseline.json
```

Run this in real mode (no `--stub`) locally, or copy the numbers from a weekly
artifact, then commit the updated file. The committed seed baseline was generated
from the stub run, so per-case rubric-score comparison stays dormant until a
maintainer commits a baseline generated from a real run.

## Readiness suite

`evals/readiness/*.md` are fixtures for the readiness judge (`judgeReadiness`, route `readiness_judge`, ADR-0167). The plan suite is untouched; select this one with `--suite readiness`.

Frontmatter: `expectedVerdict` (required: `ready`, `ready-with-assumptions`, `not-ready`, or `judge-error`), `acceptableVerdicts` (array, defaults to `[expectedVerdict]`), `mustAsk` (keywords; for not-ready cases at least one must appear, case-insensitively, in a question text), `labels`, `rubric`, `minRubricScore` (default 7), and `id`. The first `# ` heading is the ticket title and the rest is the body; an empty body is allowed.

Offline runs need a fenced `stub-output` block holding the canned verdict JSON. If it does not parse, the runner scripts it twice, because the judge makes one repair call after an unparseable reply. Use `expectedVerdict: judge-error` for a case that must end in a judge error (`stub-malformed-json`).

Metrics: accuracy (passed / total), a confusion matrix of expected vs actual verdict, false-ready rate (not-ready tickets judged ready or ready-with-assumptions), false-not-ready rate (ready or ready-with-assumptions tickets judged not-ready), must-ask hit rate, and `judgeErrors`. Each case also runs the deterministic checks `prompt-wraps-body`, `verdict-parsed`, `verdict-correct` and `must-ask`. In real mode the LLM judge scores each verdict against the case rubric.

`evals/readiness-baseline.json` tolerances: false-ready rate 0 (any rise fails), false-not-ready rate 0.10, rubric score 1.0, plus a `totalCostEstimate` budget. The weekly workflow runs the real suite and uploads `readiness-eval-report`.

```
npm run eval -- --stub --suite readiness
npm run eval -- --stub --suite readiness --baseline evals/readiness-baseline.json
npm run eval -- --suite readiness --judge-k 3 --readiness-model claude-sonnet-5-5 --judge-model claude-sonnet-5-5 --baseline evals/readiness-baseline.json
```
