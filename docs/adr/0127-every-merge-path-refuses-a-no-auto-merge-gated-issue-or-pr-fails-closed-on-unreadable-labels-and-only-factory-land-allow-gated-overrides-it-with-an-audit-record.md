# ADR-0127: Every merge path refuses a no-auto-merge-gated issue or PR, fails closed on unreadable labels, and only `factory land --allow-gated` overrides it, with an audit record

- Status: Accepted
- Date: 2026-10-01

## Context

`no-auto-merge` (`filing.selfFixLabel`) is the only "a human must approve" gate. ADR-0123's PR classifier relies on it to hold B/C-class PRs for a human. Until #1720 only `waitForMerge` honored it, and only on the issue. `factory land`, `resume-approved` and `scripts/auto-merge-sweep.sh` merged gated PRs anyway, so the gate was advisory on most paths.

## Decision

`landIssue` in `packages/cli/src/cli/index.ts` is the merge choke point for the CLI. It reads the labels on the issue and on its PR and refuses with `MergeGatedError` (exit 4 from `factory land`, plus a `merge-gated` event) when either set contains the self-fix label, or when either read fails. The only override is an explicit `factory land <n> --allow-gated`. It always prints an `AUDIT` line and writes a `merge-gated-override` event before merging. `scripts/auto-merge-sweep.sh` applies the same rule on its own (PR labels from `gh pr list`, closing-issue labels from `gh issue view`, fail closed). Its `gh pr merge` path for standalone PRs therefore can't bypass the gate. The sweep never passes `--allow-gated`. Any new code path that merges a PR must go through `landIssue` or apply this same check.

## Consequences

Gated PRs can't be merged by automation, and a label that can't be read blocks merging rather than allowing it. A temporary GitHub API failure therefore stalls landing until the next pass. A human who wants to merge a gated PR from the CLI must pass `--allow-gated`, which leaves an audit trail. `resume-approved` reports approved-but-gated PRs as failed instead of merging them. The sweep reads its gate label from `GATE_LABEL` (default `no-auto-merge`), not from the repo's `filing.selfFixLabel`; a repo that customizes the label must also set `GATE_LABEL`. `factory land` still enforces the repo's configured label as a backstop.

References: ADR-0123, issue #1720.
