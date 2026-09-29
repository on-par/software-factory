# ADR-0117: A review resolves its constitution first-hit, ending in a built-in default, and a cross-repo PR is always contained

- Status: Accepted
- Date: 2026-09-29

## Context

`factory review` (epic #1667) must work against a PR in any GitHub repository, including one that has
never seen the factory. The pipeline's `ConstitutionLoader.resolve` merges repo instruction files with a
configured product constitution and returns null when neither exists. That is the right behavior for a
factory-owned run but wrong for a review: a foreign repo has no configured product, a null constitution
would leave the reviewer with no standards, and the report must name exactly one source so the operator
knows what the PR was judged against. Separately, a PR in a repository other than the current checkout
is someone else's code on the operator's machine, which is the same trust problem ADR-0114 solved for
fork PRs.

## Decision

`ConstitutionLoader.resolveForReview(repoDir)` resolves standards first-hit and never merges:
`.factory/constitution.md` first, then the repo instruction files `ConstitutionLoader` already recognizes
(CLAUDE.md, AGENTS.md, .github/copilot-instructions.md), then the built-in `default-review` constitution
bundled in `@on-par/factory-config` (`packages/config/src/constitutions/default-review.md`). It never
returns null and it tags which source won. `describeReviewConstitutionSource` renders that tag for the
report. The default review constitution declares only built-in checkers, never `custom_*` checkers that
assume factory conventions. The containment gate takes the current checkout's `owner/name` as
`currentRepo`. A PR whose base repository differs from it requires containment exactly as a fork does:
contained when Docker is available, refused with exit 2 otherwise, and never run on the host. PR
references (number, `owner/repo#N`, github.com pull URL) are parsed by a pure core function and always
displayed as `owner/repo#N`.

## Consequences

Every review has a named set of standards, even in a bare repository. The pipeline's `resolve` is left
untouched, so factory runs keep their merge semantics. The cost is two resolution paths with different
rules that must not be confused, and a review of a repo that has both instruction files and a
`.factory/constitution.md` uses only the latter. Cross-repo reviews cannot run at all on a machine
without Docker. Non-GitHub hosts are rejected at parse time.

## References

- [Issue #1673](https://github.com/on-par/software-factory/issues/1673)
- [Epic #1667](https://github.com/on-par/software-factory/issues/1667)
