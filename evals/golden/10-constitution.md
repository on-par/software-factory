---
id: constitution-compliance
expectedRoute: codex
constitution: |
  <constitution product="eval-demo">
  # Standards for eval-demo
  - S1: Every user-facing string ships with an accessible label.
  - S2: All new public functions have a focused unit test.
  </constitution>
rubric: []
---
# Add a quiet-mode CLI flag

Add a small user-facing CLI flag that suppresses non-error progress output while
leaving errors visible. The spec must account for the product constitution
standards when planning the change.

```stub-output
---
route: codex
---
# Spec: Add a quiet-mode CLI flag (#0)
## Goal
Add a bounded quiet-mode flag to suppress routine progress output while preserving visible errors for CLI users.
## Files / approach
Update the CLI argument parsing and command output path for the affected command so the new flag is documented in help text, passed through to the command implementation, and only suppresses non-error progress messages.
## Tests
Add focused CLI tests for default output, quiet-mode output, and error output, then run npm run test -w @on-par/factory-core.
## Constitution compliance
S1: The new user-facing flag and help string ship with an accessible label in the CLI help output.
S2: Any new public option parsing helper or command function gets a focused unit test covering quiet-mode behavior.
## Non-goals
No logging framework rewrite and no changes to unrelated CLI commands.
```
