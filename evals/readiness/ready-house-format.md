---
expectedVerdict: ready
rubric:
  - "The verdict is ready with no questions"
  - "Nothing is invented beyond the ticket"
---
# Add --json flag to `factory status`

## User story
As an operator I want `factory status --json` so scripts can read lane state.

## In scope
- Add a `--json` flag to the status command in packages/cli.
- Print the same data as the table as one JSON object on stdout.

## Acceptance criteria
- `factory status --json` prints valid JSON and exits 0.
- Without the flag, output is unchanged.

## Verification
- Unit test in packages/cli parses the stdout as JSON.
- `npm run test` passes.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "ready",
  "summary": "Clear flag, scope, criteria and verification.",
  "assumptions": [],
  "questions": []
}
```
