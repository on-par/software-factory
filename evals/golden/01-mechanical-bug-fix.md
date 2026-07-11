---
id: mechanical-bug-fix
expectedRoute: codex
rubric:
  - Names packages/core/src/utils/lock.ts as the target file
  - Includes a focused regression test command
---
# Guard null lock metadata

`withGitLock` throws when an older lock file has `metadata: null`. Reproduce by
creating a lock file with a null metadata property, then acquiring the lock.
Treat missing or null metadata the same way.

```stub-output
---
route: codex
---
# Spec: Guard null lock metadata (#0)
## Goal
Make lock acquisition tolerate old lock files whose metadata is null while preserving existing behavior for valid metadata.
## Files / approach
Update packages/core/src/utils/lock.ts where lock metadata is read so null is treated like missing metadata before accessing fields. Keep the change local to the metadata normalization path.
## Tests
Add a regression case in packages/core/src/utils/lock.test.ts for a lock file containing metadata: null, then run npm run test -w @on-par/factory-core.
## Non-goals
No lock algorithm rewrite and no changes to timeout behavior.
```
