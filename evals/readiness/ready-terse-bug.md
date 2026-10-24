---
expectedVerdict: ready
rubric:
  - "The verdict is ready with no questions"
  - "Nothing is invented beyond the ticket"
---
# Crash when config file is empty

Steps:
1. Create an empty `factory.config.json`.
2. Run `factory status`.

Actual: TypeError: Cannot read properties of undefined.
Expected: a clear error `config file is empty` and exit code 1.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "ready",
  "summary": "Repro, actual and expected are all stated.",
  "assumptions": [],
  "questions": []
}
```
