# ADR-0121: A PR classifier may only escalate review until a named human promotes a class on published evidence

- Status: Accepted
- Date: 2026-10-01

## Context

Today the factory merges its own PRs without human approval unless the issue carries the `no-auto-merge` label. Nothing records who is accountable for that delegation or what evidence justified it. A colleague put the question plainly: "Who stands in the witness stand if things go south? An agent?"

We plan an opt-in `--pr-classifier` that routes each factory PR either to AI approval or to a human. The trust model has to be fixed before any code lands, so every later issue builds against one decision.

Related decisions: ADR-0113 says the review verdict blocks only on deterministic checker failures and unmet criteria, and ADR-0114 makes fork-PR containment fail closed. This ADR is about who may approve. It does not change how a verdict is computed. The `security_review` model role already exists in `packages/config/src/defaults.ts`.

The forces at play:

- A build agent has an incentive to argue its own case.
- A clean streak on a small sample is weak evidence.
- A model, prompt, or policy that changes silently invalidates evidence gathered earlier.

## Decision

### Router, not approver

The classifier routes a PR's review; it never approves on its own authority. A named human policy owner is accountable for every class promoted to auto-approve. The agent is a witness, never the defendant.

### Three classes

- **A**: AI may approve, but only once the rollout stage allows it.
- **B**: AI review, then a human approves.
- **C**: human review plus the `security_review` route.

### Deterministic floor

Deterministic rules set a minimum class. The model can only make the class stricter, never looser. The final class is max(floor, model), with the ordering A < B < C.

- Any change to the classifier itself, its policy, or the merge/land code is always C.
- Any classifier error (timeout, parse failure, missing input, unknown class) fails closed to a human.

### Staged rollout

The stages run in order:

1. Backtest.
2. Shadow: logs only, no effect on routing.
3. Escalate-only: may raise review to a human, never lowers it.
4. Auto-approve Class A, starting with docs-only and tests-only changes.

Each promotion is a human-merged PR to a versioned review-policy file that names its owner. One slipped defect on an auto-approved PR demotes one stage. So does any change to the model, the prompt, or the policy.

### Receipts

Every classified PR records:

- final, floor, and model class
- rules fired
- ADRs consulted
- cited claims
- what was not inspected
- model id
- prompt version
- policy version
- diff SHA

Next to any clean streak, report the rule-of-three bound: 0 defects in n PRs bounds the defect rate at about 3/n with 95% confidence.

### Input excludes agent prose

The classifier's input excludes agent-written prose: the PR body, commit messages, and build reasoning. The build agent cannot argue its own case. The classifier reads the diff and other repo facts only.

### Kill criterion

If the model does not beat the floor rules alone on blind human audits after about 60 shadow PRs, keep the rules and drop the model.

### Binding rule for future code

Code implementing `--pr-classifier` must follow every rule above. The flag is opt-in, and until a human promotes a class, the existing merge behavior is unchanged.

## Consequences

Positive:

- Accountability is explicit, with a named owner per promoted class.
- The worst-case error is extra human review, never a looser review.
- The evidence behind every promotion is auditable.
- Agent self-advocacy is removed from the classifier's input.

Negative or accepted costs:

- Slower path to any auto-approve.
- More human review load during shadow and escalate-only.
- Receipt storage and bookkeeping.
- Demote-on-any-change makes model or prompt upgrades expensive, which is deliberate.
- The rule-of-three bound means a meaningful rate claim needs many PRs.
- The model may be dropped entirely.

Out of scope here: any Class A categories beyond docs-only and tests-only. Each later addition is its own human-merged policy PR.
