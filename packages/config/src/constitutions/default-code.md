---
product: default-code
version: 1
checkers:
  - worker_output
  - compile
  - tests
  - lint
  - design_smells
enforced_on: [plan, build, check]
---

# Default Code Constitution

## Purpose

The default standard for a code repository that has no product-specific constitution.
`factory init` scaffolds it into `.factory/constitution.md`; edit that file to tighten
or extend the standards for this repository.

## Standards

- The change builds and type-checks with the repository's own scripts.
- Existing tests pass, and new behavior comes with tests.
- Lint is clean under the repository's own configuration.
- The diff does what the issue says, and nothing unrelated.
- There are no committed secrets, debug leftovers or disabled tests.

## Quality Gates

1. `worker_output` — the worker produced a real diff against the base.
2. `compile` — the repository's build or type-check script passes.
3. `tests` — the repository's verify or test command passes.
4. `lint` — the repository's lint script passes.
5. `design_smells` — the diff is free of design smells a reviewer would flag.

## Dispute Rules

When a checker flags a finding the worker disagrees with, the boss compares the finding
against the issue's acceptance criteria and the repository's own conventions. A finding
that contradicts either is dismissed; otherwise the worker fixes it.

## Non-Goals

- Product-specific checks. Add `custom_*` checkers by editing this file's `checkers` list.
