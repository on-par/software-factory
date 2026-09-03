# ADR-0061: factory doctor reports orphaned green PRs but never merges them

- Status: Accepted
- Date: 2026-08-29

## Context

The factory creates per-run resources — worktrees, branches, port leases, claim labels and
a PR — and #980 gave every one of them a reaper in `factory doctor --reconcile`. The PR is
the exception: a PR that reached green CI and non-draft state and was then abandoned by a
parked or killed lane is the one artifact the factory must not reclaim on its own, because
reclaiming it means landing code on `main`. #980 recorded three such PRs in a single
session (#957 merged by hand after 9 hours, #894 and #792 open for days and since drifted
into conflict), so the cost of not surfacing them is real. That leaves two questions the
code alone cannot answer: why this one resource is reported instead of reaped, and why the
report runs on plain `factory doctor` when every other lifecycle sweep is gated behind
`--reconcile`.

## Decision

`factory doctor` reports green-and-ready PRs with no merge and never acts on them.
`findUnmergedGreenPrs` (`packages/core/src/utils/green-prs.ts`) is read-only by
construction: its injected `GreenPrGitHubClient` port exposes only `listOpenPullRequests`
and `listCheckRuns`, so no future caller can reach a merge or close through it. The scan
runs on plain `factory doctor`, not behind `--reconcile`, precisely because it has no side
effects — `--reconcile` remains the flag that grants mutation authority. Each orphan is
rendered as an `optional: true` check, so the report warns and never changes the doctor
exit code. Greenness is not re-defined here: `utils/ci-watch.ts` exports
`isPassingConclusion`, the single fail-closed allow-list ADR-0014 established for the merge
gate, and the scan reuses it, so a PR the merge gate would refuse can never be reported as
green. The owning issue comes from the PR body's closing keyword, falling back to the
`<prefix>/<issue>-<slug>` branch name, and is reported as unknown rather than guessed.

## Consequences

Positive: merge authority stays an explicit human or auto-merge grant — the reaper story of
#980 can never grow into "doctor landed code on main". One definition of green serves both
the merge gate and the report, so they can never disagree. The report is safe to run
unconditionally, which is what makes it useful: the orphan is visible the next time anyone
runs doctor, not only when they remember `--reconcile`.
Negative: the orphan still needs a human (or `factory ship`) to land it — doctor makes the
debris visible without removing it, so a repeatedly ignored warning is the failure mode.
Every `factory doctor` now spends one `pulls.list` plus one `checks.listForRef` per open
non-draft PR against the GitHub API, and reports open non-factory PRs too, since a green
PR's provenance is not something the scan tries to infer.

## References

- [#980 — factory: no run-lifecycle reaping](https://github.com/on-par/software-factory/issues/980)
- [ADR-0014 — CI merge gate fails closed on non-allow-listed check conclusions](docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md)
- [Issue #1000](https://github.com/on-par/software-factory/issues/1000)
