# Eval Golden Cases

Each `evals/golden/*.md` file is one issue-shaped prompt fixture.
Frontmatter may set `id`, `expectedRoute`, `deterministicOnly`, `rubric`, and `minRubricScore`.
The first `# ` heading becomes the issue title.
All markdown after that heading becomes the issue body.
Use `expectedRoute: any` when only spec structure matters.
Use `deterministicOnly: true` to skip the LLM judge even in real mode.
Add rubric items only for cases that need qualitative scoring.
For offline runs, include a fenced `stub-output` block with the canned PLAN output.
Run `npm run eval -- --stub` before committing prompt or golden-set changes.
CI also runs the stub subset on every PR, so a broken prompt or golden case fails the PR check at zero model cost.
