# ADR-0167: Readiness is a model-judged three-way verdict, and PLAN never rewrites the ticket

- Status: Accepted
- Date: 2026-10-22
- Amends: [ADR-0010](0010-the-readiness-size-gate-re-implements-the-invest-small-rule-inside-core.md), [ADR-0107](0107-epic-readiness-recognizes-a-second-house-style-via-a-hand-picked-field-synonym-table.md) (the heading score becomes advisory telemetry; it no longer gates)
- Issue: #3457

## Context

Readiness today is a heading check. `scoreIssueReadiness` (`packages/core/src/readiness/index.ts`) looks for required Markdown headings and picks a template via `detectTemplate`. When a `factory-task` issue fails the check, PLAN calls the `readiness_enrich` route (`packages/config/src/defaults-routes.ts`) and writes the generated sections back into the human's GitHub issue with `octokit.rest.issues.update` in `packages/core/src/phases/plan.ts` (#2385). That write-back has no ADR. The fast path (`packages/core/src/efficiency/fast-path.ts`) is gated on the same pass, and `factory check` (`packages/cli/src/cli/ready-check.ts`) exits 1 on missing headings.

A Jira description converted from ADF can never satisfy a heading check, so non-GitHub trackers cannot be served. Separately, the factory edits a ticket a human wrote. The tracker-source grill (2026-10-21) chose a model-judged verdict and no ticket rewrite.

## Decision

1. **Verdicts.** A model judges the ticket and returns one of three verdicts.

   | Verdict                  | Run                                                      | Ticket                                                                             | PR                                      |
   | ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
   | `ready`                  | Proceeds to PLAN.                                        | Untouched.                                                                         | No readiness section.                   |
   | `ready-with-assumptions` | Proceeds; the assumptions are handed to PLAN.            | Untouched.                                                                         | The assumptions are listed in the body. |
   | `not-ready`              | Parks with the new park reason `not-ready`; no PLAN run. | One comment lists the questions: the existing park-state comment, edited in place. | None is opened.                         |

2. **Judge contract.** The `readiness_judge` route (tier `triage`, tool-less, JSON output) replaces `readiness_enrich`. Output is a strict zod schema, version 1, with per-verdict invariants: `not-ready` has at least one question, `ready-with-assumptions` has at least one assumption, `ready` has neither. At most 5 questions and 5 assumptions, each tagged with an `aspect`. The body is wrapped with `wrapUntrustedIssueBody` (`packages/core/src/utils/untrusted-input.ts`), which extends ADR-0129. The judge sees `stripHiddenContent(stripEnrichedBlock(body))`.
3. **Cache.** Verdicts are cached keyed by prompt version, title and prepared body. The model is not in the key. There is no expiry. Invalid output is never cached. A cache I/O error is a miss (follows ADR-0140).
4. **Fail closed.** Invalid model output gets one repair retry. If it is still invalid, or the router errors, enforce mode escalates with no comment and no cache entry. Advisory mode warns and proceeds. `factory check` exits 2.
5. **Deterministic checks that stay**, each for its own reason:
   - Epic detection by title, label or issue type. A detected epic skips the judge and goes to PLAN as today (maintainer decision 2026-10-21).
   - `Prerequisite: #N` blockers: a dependency is a fact about the queue, not about prose quality.
   - The duplicate guard: it compares against other issues, which the judge never sees.
   - The fast-path heading test, applied only after a `ready` verdict: it selects a cheaper template, not whether to run.
   - `scoreIssueReadiness` and its `templates.test.ts` coupling, kept as advisory telemetry so `meanReadinessScore` history stays comparable (ADR-0011). It no longer gates.
6. **Size.** The judge never parks on size. ADR-0165's post-plan estimate decides. Slice stories are not re-judged.
7. **Default and scope.** The shipped default is `advisory`. This repo opts into `enforce` (maintainer decision 2026-10-21), following ADR-0158's opt-in until eval data exists. The judge reads title and body only. A human answers by editing the description; comments are not read, and v1 has no override label. The model stays on the `triage` tier until real-mode evals decide on a pin.
8. **No ticket rewrite.** Ticket bodies are never rewritten. `readiness.updateIssueBody` (and `FACTORY_READINESS_UPDATE_BODY`) is deprecated for one release per ADR-0160. A new mode key `readiness.judge: enforce | advisory | off` is overridden by `FACTORY_READINESS_JUDGE`.
9. **Single comment seam.** `publishParkComment` (`packages/core/src/run/park-comment.ts`) is the only call site that posts the questions. It is the seam to move behind a future `tracker.comment(key, markdown)`.

## Rejected alternatives

- **Heading gate plus LLM fallback.** Keeps the ADF failure mode and leaves two readiness rules.
- **Keeping enrichment.** It rewrites the human's ticket.
- **A numeric confidence threshold.** The verdict categories are the contract; a threshold invites tuning without eval data.
- **A separate questions comment.** Two comments to keep in sync; the park-state comment already exists.
- **Giving the judge repo context or tools.** Cost, prompt-injection surface, and readiness is about the ticket, not the code.
- **A per-model cache key.** Model swaps would invalidate history and re-judge unchanged tickets.

## Consequences

- Jira/ADF tickets can be judged.
- The factory never edits a ticket.
- `meanReadinessScore` remains comparable across the change.
- Enforce-mode outages escalate rather than proceed.
- #3467–#3470 implement this decision.
- ADR-0010, ADR-0107 and ADR-0129 are not edited; this ADR amends or extends them.
