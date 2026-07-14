---
id: local-small-first-green
expectedRoute: codex
deterministicOnly: true
---
# Add the local-small first-green marker

Create `docs/local-small-first-green.md` with exactly this content:

```markdown
# Local-Small First Green

This file is the canonical tiny success target for local-small factory runs.
```

Expected diff: one new Markdown file under 10 lines.
Verification command: `test -f docs/local-small-first-green.md && rg "canonical tiny success target" docs/local-small-first-green.md`.
Success means the factory can produce a clean patch and review-only PR or dry-run report for the smallest unambiguous task before attempting real issues.

```stub-output
---
route: codex
---
# Spec: Add the local-small first-green marker (#0)
## Goal
Add a deliberately tiny docs-only marker file that serves as the canonical first-green target for local-small factory runs.
## Files / approach
Create docs/local-small-first-green.md with exactly the requested heading and sentence. This is routed to codex because the change is mechanical, bounded, and has an exact expected diff.
## Tests
Run: test -f docs/local-small-first-green.md && rg "canonical tiny success target" docs/local-small-first-green.md
## Non-goals
Do not change runtime harness code, model routing, eval scoring, or queue behavior.
```
