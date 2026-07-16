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

Run the same pinned real eval locally:

```
npm run eval -- --judge-k 3 --plan-model claude-fable-5 --judge-model claude-sonnet-5 --report eval-report.json --baseline evals/baseline.json
```

Refresh the baseline after an intentional prompt or golden-set change:

```
npm run eval -- --plan-model claude-fable-5 --judge-model claude-sonnet-5 --write-baseline evals/baseline.json
```

Run this in real mode (no `--stub`) locally, or copy the numbers from a weekly
artifact, then commit the updated file. The committed seed baseline was generated
from the stub run, so per-case rubric-score comparison stays dormant until a
maintainer commits a baseline generated from a real run.
