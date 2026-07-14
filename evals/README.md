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
Run `npm run eval -- --stub` before committing prompt or golden-set changes.
CI also runs the stub subset on every PR, so a broken prompt or golden case fails the PR check at zero model cost.

## Local-small first green

The canonical first-green local-small yardstick is `local-small-first-green`.
It is intentionally a tiny docs-only issue with an exact expected diff and one
cheap verification command, so failures point at harness or model behavior
rather than task ambiguity.

Run only that case with:

```
npm run eval -- --stub --filter local-small-first-green --no-judge
```

## Nightly full eval run

The `Nightly Evals` workflow (`.github/workflows/nightly-evals.yml`) runs the full
scored suite — real models, LLM judge, no `--stub` — nightly and on
`workflow_dispatch`, then compares the results against the committed baseline at
`evals/baseline.json`, failing the job if any case regresses beyond its tolerance.
The run report is always uploaded as a build artifact, even on failure.

Refresh the baseline after an intentional prompt or golden-set change:

```
npm run eval -- --write-baseline evals/baseline.json
```

Run this in real mode (no `--stub`) locally, or copy the numbers from a nightly
artifact, then commit the updated file. The committed seed baseline was generated
from the stub run, so per-case rubric-score comparison stays dormant until a
maintainer commits a baseline generated from a real run.
