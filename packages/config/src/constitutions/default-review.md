---
product: default-review
version: 1
checkers:
  - compile
  - tests
  - lint
enforced_on: [check]
---

# Default Review Constitution

## Purpose

The fallback standard for reviewing a pull request in a repository that has no
`.factory/constitution.md` and none of `CLAUDE.md`, `AGENTS.md` or
`.github/copilot-instructions.md`.

## Standards

- The change builds and type-checks with the repository's own scripts.
- Existing tests pass, and new behavior comes with tests where the repository has a test suite.
- Lint is clean under the repository's own configuration.
- The diff does what the PR title, body and linked issue say, and nothing unrelated.
- There are no committed secrets, debug leftovers or disabled tests.

## Checkers

Only the built-in compile, tests and lint checkers apply (links and accessibility
always run). No `custom_*` checkers are declared because the reviewed repository has
not opted into factory conventions.
