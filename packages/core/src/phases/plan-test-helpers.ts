import { StubModelExecutor as BaseStubModelExecutor, type StubModelExecutorOptions } from '../router/stub.js';
import { MAX_DESIGN_ARTIFACT_RETRIES } from './plan-design-retry.js';

/** A planner spec whose design: block validates, so PLAN does not re-prompt (#2803). */
export function specWithDesign(title: string): string {
  return `---
route: codex
design:
  restatedProblem: The problem statement, restated.
  approach:
    chosen: Do the thing.
    rejected: []
  interfacesTouched:
    - packages/core/src/foo.ts
  behaviorContract:
    - Foo now does bar.
  verificationPlan:
    - command: npm test
      passWhen: tests pass
  riskBlastRadius: Nothing breaks.
  openQuestions: []
---
# ${title}
`;
}

/**
 * PLAN re-prompts an invalid design artifact up to MAX_DESIGN_ARTIFACT_RETRIES times (#2803), so a
 * stub planner whose spec has no valid design block is asked again. Repeat the last scripted plan step
 * so those retries get the same response instead of exhausting the script.
 */
export class StubModelExecutor extends BaseStubModelExecutor {
  constructor(options: StubModelExecutorOptions = {}) {
    const plan = options.scripts?.plan;
    super(
      plan && plan.length > 0
        ? {
            ...options,
            scripts: {
              ...options.scripts,
              plan: [...plan, ...Array(MAX_DESIGN_ARTIFACT_RETRIES).fill(plan[plan.length - 1])],
            },
          }
        : options,
    );
  }
}
