---
expectedVerdict: not-ready
mustAsk: [which, decide]
rubric:
  - "Each question is specific and answerable by a human"
  - "Questions are not redundant"
  - "No scope is invented beyond the ticket"
---
# Handle duplicate issue filings

When a user files an issue that looks like a duplicate, we could either block the filing and link the original, or allow it and add a "possible duplicate" label. Implement this.

```stub-output
{
  "schemaVersion": 1,
  "verdict": "not-ready",
  "summary": "A user-visible product decision is open.",
  "assumptions": [],
  "questions": [
    {
      "aspect": "decision",
      "text": "Which behaviour do we want: block the filing or label it as a possible duplicate?"
    },
    {
      "aspect": "decision",
      "text": "Who should decide when a filing counts as a duplicate?"
    }
  ]
}
```
