---
id: test-writing
expectedRoute: codex
rubric:
  - Focuses on adding tests rather than production changes
  - Includes the core workspace test command
---
# Add tests for the lock util

The lock utility has coverage for the happy path only. Add tests for stale lock
cleanup and contention timeout using the existing temp-directory style.

```stub-output
---
route: codex
---
# Spec: Add tests for the lock util (#0)
## Goal
Increase confidence in the lock utility by covering stale lock cleanup and timeout behavior without changing production lock semantics.
## Files / approach
Add cases to packages/core/src/utils/lock.test.ts using mkdtemp temp directories. Cover a stale lock file being replaced and a contended lock timing out with the expected error.
## Tests
Run npm run test -w @on-par/factory-core.
## Non-goals
No implementation changes unless required to make the documented behavior testable.
```
