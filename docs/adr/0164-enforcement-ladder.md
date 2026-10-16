# ADR-0164: Push each agent correction as high up the enforcement ladder as it goes

- Status: Accepted
- Date: 2026-10-16
- Issue: #1004

## Context

When an agent gets something wrong, the cheap fix is a sentence: a line in `AGENTS.md`, a skill, a constitution or a
review comment. Prose is easy to write and easy to ignore. The next agent may not load it, may load it and miss it,
or may follow it once and drift. The same bug then comes back, and a human catches it in review again.

#1004 is an example. Its fix was closed as delivered on the strength of a unit test on `ensureLabel`'s return value.
The `POST .../labels - 422` noise still reached stderr, because nothing checked the output the user actually sees. A
CLI regression test through the real Octokit client now fails if the line comes back.

On PAR Dev's Software Factory already turns some rules into gates: CHECK blocks on a high-confidence lens-review
showstopper and fails closed on lens errors
([ADR-0158](0158-check-may-block-on-a-model-judged-lens-review-showstopper-at-90-confidence-and-fails-closed-on-lens-errors.md)),
and CI rework diffs are guarded against suppressing checks
([ADR-0162](0162-ci-rework-diffs-are-guarded-against-suppression-and-park-as-ci-failed-suppression-attempt.md)). This
ADR makes a gate the default answer to every correction.

## Decision

When we correct an agent, or fix a bug that has happened before, we push the fix as high up this ladder as it goes:

1. **Codebase.** Make the wrong thing impossible or loud: types, invariants, narrow boundaries, safe defaults.
2. **Static analysis and CI.** A lint rule, test, guard test or verify step that fails when the mistake comes back.
3. **Prose.** `AGENTS.md`, a skill, a constitution, an ADR or a code comment.
4. **Human review.** A person notices it on the PR.

- We go down a rung only when the rung above cannot express the rule, or would cost more than the mistake.
- The PR template asks the question, so every PR that fixes a correction or a repeat bug answers it.
- Taste and product calls may stay prose. Naming, tone, scope and "is this worth building" are judgments, not
  invariants.
- We avoid noisy checks. A check that fires on correct code, or that people learn to bypass, is worse than prose. When
  in doubt, a narrow check beats a broad one.
- A repeat bug gets the `correction` label, so the Gardener can count how often each kind of mistake comes back and
  show which rules still live only in prose.

## Consequences

- Fixes for corrections usually ship with a test, type or check, and the PR says which rung it reached and why not
  higher.
- Prose files stay shorter. They hold judgment calls and pointers to the checks that enforce the rest.
- Some corrections cost more up front. A failing test is slower to write than a sentence, but it does not drift.
- The `correction` label count is a signal for the Gardener. A rising count for one kind of mistake means it needs a
  higher rung.
