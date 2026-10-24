---
expectedVerdict: ready-with-assumptions
rubric:
  - "Each assumption is specific and names a concrete default"
  - "No question is asked"
  - "No scope is invented beyond the ticket"
---
# Trim trailing whitespace in generated reports

Generated report files currently end with extra blank lines. Strip trailing whitespace from every line and end the file with a single newline.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "ready-with-assumptions",
  "summary": "Clear change; verification is implied.",
  "assumptions": [
    {
      "aspect": "verification",
      "text": "A unit test over the report writer verifies the output; no manual check is needed."
    }
  ],
  "questions": []
}
```
