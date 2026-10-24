---
route: claude
design:
  restatedProblem: PLAN's design artifact has no ordered, per-step breakdown for BUILD.
  approach:
    chosen: Add an optional outline of vertical slices to the design artifact.
    rejected: []
  interfacesTouched:
    - packages/contracts/src/design.ts
    - packages/core/src/design/index.ts
    - packages/core/src/phases/plan.ts
  behaviorContract:
    - The outline parses, renders into design.md and the BUILD grounding block.
  verificationPlan:
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0
  riskBlastRadius: A too-strict schema would drop design grounding for malformed outlines.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: The outline renders into the BUILD grounding block.
      test: packages/core/src/design/index.test.ts — multi-slice outline golden
  outline:
    - result: The design schema accepts and validates an outline.
      files:
        - packages/contracts/src/design.ts
      automatedChecks:
        - npx vitest run packages/contracts/src/design.test.ts
      manualChecks: []
    - result: The outline renders in design.md and the BUILD grounding block.
      files:
        - packages/core/src/design/index.ts
      automatedChecks:
        - npx vitest run packages/core/src/design/index.test.ts
      manualChecks:
        - Read the rendered design.md for a sample plan.
    - result: The PLAN prompt requires the outline.
      files:
        - packages/core/src/phases/plan.ts
      automatedChecks:
        - npx vitest run packages/core/src/phases/plan.test.ts
---

# Spec: multi-slice outline golden
