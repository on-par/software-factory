# Constitution Template

A constitution is a written standard that defines "done right" for a product.
Every build round is tested against it. The prompt isn't instructions — it's
a standard plus a way to check it.

## Format

```markdown
---
product: <product-name>
version: 1
checkers:
  - <checker-name> # References lib/checkers/<checker-name>.sh
  - <checker-name>
enforced_on: [plan, build, check] # Which phases load this constitution
requireTests: true # FAIL (instead of SKIP) the tests checker when the repo has no verify/test command
---

# <Product> Constitution

## Purpose

<One paragraph: what this product does and who it's for>

## Standards

### <Standard Category 1>

<What "done right" means for this category. Be specific and testable.>

### <Standard Category 2>

<...>

## Quality Gates

<Which checks must pass before work ships. References checkers in lib/checkers/.>

## Dispute Rules

<How the boss should arbitrate when a worker disputes a checker failure.
Reference the standards above, not subjective judgment.>

## Non-Goals

<What this constitution does NOT cover — explicitly out of scope.>
```

## Writing a Constitution

1. **Name what "done right" means** — concrete, testable criteria, not vibes.
2. **Map each standard to a checker** — every standard should be machine-verifiable.
3. **Define dispute rules** — when a worker says "the checker is wrong," the boss needs a principled way to decide. Reference the standards, not opinion.
4. **List non-goals** — prevents scope creep and false failures from checkers testing things that don't matter for this product.

## How It's Used

- **PLAN phase**: The boss reads the constitution before writing the spec. The spec must satisfy every standard.
- **BUILD phase**: The worker receives the constitution alongside the spec. It's the standard the work will be checked against.
- **CHECK phase**: Each checker reads the relevant standards section and verifies the output against it — not against the worker's self-report.
- **DISPUTE**: When a worker escalates a checker failure, the boss re-reads the constitution to decide. Standards outrank both worker and checker.
