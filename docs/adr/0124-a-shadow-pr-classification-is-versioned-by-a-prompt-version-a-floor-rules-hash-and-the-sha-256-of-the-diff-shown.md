# ADR-0124: A shadow PR classification is versioned by a hand-bumped prompt version, a content hash of the effective floor rules, and the SHA-256 of the exact diff shown to the model

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0121 requires every classified PR to record the model id, prompt version, policy version and diff SHA. It also requires any change to the model, prompt or policy to demote a promoted class. Without a fixed definition, each later stage (escalate-only, auto-approve, backtests) could compute these differently, and evidence gathered under one definition would silently mix with evidence under another. No versioned review-policy file exists yet. The effective policy is the packaged floor rules merged with the repo's classifier config (ADR-0122). A commit SHA does not identify what the model saw, because CHECK and the classifier also read uncommitted worktree changes.

## Decision

`packages/core/src/review/classifier.ts` owns three version stamps. `CLASSIFIER_PROMPT_VERSION` is a string constant (`classify-pr/v1`). It must be bumped in the same change as any edit to `buildClassifierPrompt`'s wording or inputs. `classifierPolicyVersion(rules)` is `floor-` followed by the first 12 hex characters of the SHA-256 of `JSON.stringify` of the effective `ReviewFloorRuleSet`, so any repo or packaged rule change produces a new policy version without a manual bump. `diffSha` is the full SHA-256 hex of the exact diff text placed in the prompt, after truncation. These stamps, plus the model id the router actually used, are written on every `pr-classified` event in its structured `prClassification` field. The classifier's input is restricted by `ClassifierPromptInput`'s type to the diff, issue title and body, frozen spec and design, floor result and ranked ADRs. The diff is collected with `git diff` only. The verdict is shadow-only: it runs after the gate (ADR-0123) is decided and never changes it.

## Consequences

Positive: evidence can be partitioned exactly by (model, prompt, policy). A policy change is detected mechanically. A receipt can be replayed against the identical diff.

Negative: rule edits that do not change behavior (reordering, a cosmetic id rename) still mint a new policy version and reset a streak. The prompt version depends on authors remembering to bump it. Reviewers must check this on any classifier prompt edit, and that edit is class C under the floor anyway.

References: ADR-0121, ADR-0151, ADR-0123, issue #1725.
