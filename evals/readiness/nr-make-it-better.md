---
expectedVerdict: not-ready
mustAsk: [what, which]
rubric:
  - "Each question is specific and answerable by a human"
  - "Questions are not redundant"
  - "No scope is invented beyond the ticket"
---
# Make it better

The workflow should be better. Please improve the bad parts and make it feel nicer.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "not-ready",
  "summary": "No concrete outcome is stated.",
  "assumptions": [],
  "questions": [
    {
      "aspect": "problem",
      "text": "What is the current problem, and which workflow is meant?"
    },
    {
      "aspect": "acceptance",
      "text": "Which outcome should change so we know it is better?"
    }
  ]
}
```
