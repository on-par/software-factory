---
expectedVerdict: ready-with-assumptions
rubric:
  - "Each assumption is specific and names a concrete default"
  - "No question is asked"
  - "No scope is invented beyond the ticket"
---
# Show lane age in the status table

Add an `age` column to the status table showing how long each lane has been running, such as `3m`. Add a test for the formatting.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "ready-with-assumptions",
  "summary": "Buildable; out-of-scope is not stated.",
  "assumptions": [
    {
      "aspect": "scope",
      "text": "Only the CLI table changes; JSON output and the web UI are out of scope."
    }
  ],
  "questions": []
}
```
