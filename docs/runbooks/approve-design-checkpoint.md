# Approve a design checkpoint (`factory:needs-design`)

Add the `factory:needs-design` label to an issue to opt in to a human design review. The run plans as usual, then parks as `held` before BUILD, keeping the frozen plan (#3621). Unlabeled issues are unaffected.

## Steps

1. Add `factory:needs-design` to the issue before it is claimed. The label match ignores case and surrounding whitespace.
2. When PLAN finishes, the park comment says the run paused for a design review, names the plan artifact and the branch, and says how to approve.
3. Review the plan at `.factory/state/plans/issue-N.md`.
4. Remove the `factory:needs-design` label.
5. Run `factory unpark N`.

## What the next claim does

| State on the next claim                   | Result                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Label removed, issue body unchanged       | Reuses the frozen plan (no second PLAN model call) and builds on the same branch. |
| Label still present, issue body unchanged | Reuses the frozen plan and parks again with the same receipt.                     |
| Issue body edited                         | The plan no longer matches, so PLAN runs again and the gate applies again.        |

## Notes

- Local-brief work and `localOnly` runs skip the gate.
- If GitHub labels cannot be read, the run logs an `environment_warning` and continues to BUILD.
