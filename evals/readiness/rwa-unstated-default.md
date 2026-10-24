---
expectedVerdict: ready-with-assumptions
rubric:
  - "Each assumption is specific and names a concrete default"
  - "No question is asked"
  - "No scope is invented beyond the ticket"
---
# Add a --max-lanes option

Add a `--max-lanes <n>` option to `factory run` that limits how many lanes run at once. Reject values below 1 with an error.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "ready-with-assumptions",
  "summary": "Buildable once the default is assumed.",
  "assumptions": [
    {
      "aspect": "scope",
      "text": "The default when --max-lanes is omitted is the current behaviour: no limit."
    }
  ],
  "questions": []
}
```
