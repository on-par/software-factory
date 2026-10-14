# ADR-0162: CI rework diffs are guarded against suppression and park as ci-failed suppression-attempt

- Status: Accepted
- Date: 2026-10-14
- Issue: #2818

## Context

When CI fails on CodeQL alerts the PR caused, the factory can send the alerts back to BUILD for rework instead of
parking at once (#2816, #2817). That creates an incentive to make the alert go away by hiding it: a `codeql[...]`,
`lgtm` or `nosec` comment, a security `eslint-disable`, or an edit to a workflow, CodeQL config or `.sarif` file.
The only barrier was a prompt instruction (`CI_REWORK_INSTRUCTIONS`). A suppressed finding could be pushed, turn the
PR green and auto-merge without a human seeing it.

## Decision

- Attributable CodeQL failures get bounded BUILD rework before the run parks. The budget is
  `resolveMaxCiReworkRounds` (default 2) and is separate from CHECK's own rework rounds.
- Non-attributable and baseline failures park `ci-failed` without rework (#2817).
- After every CI rework round, `shipWithCiRework` diffs `<pre-rework HEAD>..HEAD` and passes it to
  `scanReworkDiff`, the single owner of the suppression rule list. Comment rules apply to added lines only; path rules
  apply to every file in the diff header, either side of a rename.
- Any hit, or any failure to read the HEAD or the diff, parks the run `ci-failed` with `suppression-attempt` in the
  message and `ciFailure.suppressionAttempt` findings. This happens before the re-CHECK, the push and the re-watch.
  The guard fails closed.
- The factory never calls code-scanning alert dismiss or update endpoints.
- The local CHECK rework loop is not guarded.

## Consequences

- No automatic suppression reaches the PR through CI rework.
- A legitimate workflow edit during CI rework parks for a human. That is the safe direction.
- The list is a deny-list of known suppression forms. Widen it only together with a test row.

## References

- #2816, #2817, #2818, #2252
- [ADR-0014](0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md) (fail-closed reasoning)
