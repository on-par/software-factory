---
id: deterministic-shape
expectedRoute: any
deterministicOnly: true
rubric: []
---
# Keep spec shape stable

Assert only that a PLAN output has frontmatter, a parseable route, and the
required sections. This case should never call the LLM judge.

```stub-output
---
route: codex
---
# Spec: Keep spec shape stable (#0)
## Goal
Verify that deterministic eval checks accept a correctly shaped spec.
## Files / approach
Use the eval scorer to check frontmatter, route parsing, and required headings.
## Tests
Run npm run eval -- --stub.
## Non-goals
No qualitative rubric scoring for this case.
```
