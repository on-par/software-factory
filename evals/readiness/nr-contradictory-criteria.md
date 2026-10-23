---
expectedVerdict: not-ready
mustAsk: [contradict, conflict]
rubric:
  - "Each question is specific and answerable by a human"
  - "Questions are not redundant"
  - "No scope is invented beyond the ticket"
---
# Retry failed lanes automatically

Acceptance criteria:
- A failed lane is retried automatically up to 3 times.
- A failed lane is never retried automatically; an operator must unpark it.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "not-ready",
  "summary": "The two criteria contradict each other.",
  "assumptions": [],
  "questions": [
    {
      "aspect": "contradiction",
      "text": "The criteria contradict each other: are failed lanes retried automatically or never?"
    }
  ]
}
```
