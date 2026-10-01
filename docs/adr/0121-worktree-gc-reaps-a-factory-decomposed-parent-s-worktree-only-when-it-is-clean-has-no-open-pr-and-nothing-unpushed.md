# ADR-0121: worktree-gc reaps a `factory:decomposed` parent's worktree only when it is clean, has no open PR and nothing unpushed

- Status: Accepted
- Date: 2026-10-01

## Context

When the PLAN size gate splits an oversized issue into sub-issues, the parent stays open, never opens a PR and is not parked. None of worktree-gc's hard-evidence reasons fire for it (merged, remote-gone, issue-closed, issue-parked; ADR-0073/0074), so its lane worktree lingers until the 7-day TTL. The sweep also ran only at `factory run` start, so one-shot `factory ship` / `factory run-issue` users got no cleanup at all. The fix needs a signal the sweep can read in the single `issues.get` it already memoizes per issue. It must also never lose work: the decomposed parent may have been partially built before the size gate fired.

## Decision

`fileDecomposition` labels the parent `factory:decomposed` (`DECOMPOSED_LABEL` in `packages/core/src/queue/github-queue.ts`) once at least one child issue is filed. The label write is best-effort. `sweepWorktrees` treats that label, on an open issue, as a third issue disposition after closed and parked. It reaps with reason `issue-decomposed`, at any age, only when all of these hold:

- the worktree has no tracked modifications,
- the branch has no open PR (unlike issue-parked, an open PR always wins here),
- the head has no commits missing from every origin ref.

The local branch is force-deleted only when the head has zero commits beyond `origin/main`. A decomposed-parent worktree that fails any of those checks is kept and listed in the new `GcReport.held` with the reason. The reason is hard evidence, so its action is `remove`, not quarantine (ADR-0090). The same `autoGcOnRun`-gated sweep now also runs at the start of `factory ship` and `factory run-issue`, not only `factory run`.

## Consequences

Decomposed parents stop accumulating worktrees, and one-shot operators get the same cleanup as `factory run`. The label becomes a durable contract: removing it by hand makes the worktree fall back to TTL-only reaping, and future code that marks an issue as decomposed must use `DECOMPOSED_LABEL`. A worktree whose pushed commits go beyond base loses its checkout but keeps its local branch. A label write failure only degrades to the old TTL behavior. One-shot commands now pay for one GC sweep at startup when `autoGcOnRun` is on.

References: ADR-0073, ADR-0074, ADR-0090; [issue #1756](https://github.com/on-par/software-factory/issues/1756).
