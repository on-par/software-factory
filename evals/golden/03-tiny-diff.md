---
id: tiny-diff
expectedRoute: claude
rubric:
  - Identifies this as a tiny config-only change
---
# Increase merge poll interval

Change the default merge poll interval from 30 seconds to 45 seconds in the
factory config. This should be a one-line configuration tweak.

```stub-output
---
route: claude
---
# Spec: Increase merge poll interval (#0)
## Goal
Change the default merge polling cadence from 30 seconds to 45 seconds.
## Files / approach
Edit packages/config/src/factory.json and update the mergePollSeconds value from 30 to 45. This is intentionally routed to claude because it is a tiny diff under 20 lines.
## Tests
Run npm run typecheck to confirm config imports still compile.
## Non-goals
No polling implementation changes and no CLI behavior changes.
```
