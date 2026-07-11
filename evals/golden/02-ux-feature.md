---
id: ux-feature
expectedRoute: claude
rubric:
  - Explains the status output design surface
  - Leaves implementation details bounded
---
# Redesign factory status output

The current `factory status` output is hard to scan. Redesign it so operators can
quickly see active lanes, parked work, and failures. Use judgment about labels,
grouping, and order.

```stub-output
---
route: claude
---
# Spec: Redesign factory status output (#0)
## Goal
Improve the CLI status view so operators can scan lane health, blocked work, and recent failures without changing the underlying factory state.
## Files / approach
Update packages/cli/src/cli/index.ts in the status command. Rework the displayed grouping and labels for queue, product, model availability, and recent events, using the existing chalk style and CLI conventions.
## Tests
Update or add CLI output tests around the status rendering path if present, then run npm run test -w @on-par/factory-cli.
## Non-goals
No new persistence format, no web dashboard, and no changes to queue semantics.
```
