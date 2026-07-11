---
id: ambiguous-route
expectedRoute: claude
rubric:
  - Explicitly justifies the chosen route
  - Acknowledges the work could plausibly route either way
---
# Tighten retry backoff for a flaky external call

The sync job sometimes fails because an external API returns transient 503s.
Add bounded retry and backoff around the call, but choose semantics that avoid
masking real failures or making the job too slow. This is partly mechanical, yet
the acceptable retry policy is a product and operations judgment call.

```stub-output
---
route: claude
---
# Spec: Tighten retry backoff for a flaky external call (#0)
## Goal
Reduce transient sync failures from short-lived 503 responses while keeping real upstream outages visible.
## Files / approach
Find the external API call in the sync job and add bounded retry/backoff around only that call. This work could plausibly route either way because the code change is bounded, but the acceptable retry semantics require judgment; because the case is genuinely ambiguous, follow the documented default of routing to claude when unsure.
## Tests
Add focused unit coverage for retryable and non-retryable responses, then run the package test command that covers the sync job.
## Non-goals
No broad job scheduler redesign and no changes to unrelated external calls.
```
