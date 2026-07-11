# Constitutions Guide

## What is a Constitution?

A constitution is a written standard that defines "done right" for a product. Every build round is tested against it. The prompt isn't instructions — it's a standard plus a way to check it.

This is the core insight from the multi-agent pattern: **you name what "done right" means one time at the top, and the system enforces it on every round while you do something else.**

## Format

```markdown
---
product: <name>
version: 1
checkers:
  - compile
  - tests
  - custom_my_check
enforced_on: [plan, build, check]
---

# <Product> Constitution

## Purpose
<One paragraph>

## Standards
### <Category>
<Testable, concrete criteria>

## Quality Gates
<Which checkers must pass>

## Dispute Rules
<How the boss arbitrates>

## Non-Goals
<What's out of scope>
```

## Writing Good Standards

### Do
- **Be specific and testable** — "Every `<img>` must have meaningful `alt` text" (not "images should be accessible")
- **Reference exact values** — "Color palette must use hex values from the brand spec" (not "use brand colors")
- **Define tolerance** — "Title tags ≤60 chars" with "±10% tolerance" in dispute rules
- **Map to checkers** — every standard should have a corresponding checker

### Don't
- **Be subjective** — "copy should sound professional" (how does a checker verify this?)
- **Be vague** — "good accessibility" (which WCAG level? which checks?)
- **Overlap without hierarchy** — if two standards conflict, the dispute rules need to say which wins

## Dispute Rules

Dispute rules are how the boss decides when a worker says "the checker is wrong." The boss re-reads the constitution and decides based on the standards — not opinion.

Good dispute rules:
- **Reference the standard** — "If the copy matches the brand voice spec, the checker is overruled"
- **Define tolerance** — "±10% on SEO length limits; beyond that, worker must justify"
- **Have a fallback** — "If the spec is ambiguous, the boss updates the spec and re-runs"

## Custom Checkers

Custom checkers come in two flavors:

1. **Agent-based** (no code needed) — the constitution's standards section IS the checker prompt. A checker agent reads it and verifies the worktree. Slower but flexible.

2. **Code-based** (faster, no model cost) — add a bash function `check_custom_<name>()` to `lib/checkers/custom.sh`. Returns JSON `{checker, result, details}`.

Use agent-based for anything subjective (brand voice, tone, design fit). Use code-based for deterministic checks (file exists, JSON valid, values match).

## Examples

See:
- `constitutions/example-marketing-site.md` — static site generation with brand, accessibility, SEO
- `constitutions/example-data-app.md` — data analysis with data verification
- `constitutions/example-client-delivery.md` — client delivery with client brand adherence
- `constitutions/_template.md` — blank template to start from