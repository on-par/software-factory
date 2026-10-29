import { type WorkKey } from '../work/work-key.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { fakeOctokit } from '../test-support/index.js';
import { planPhase } from './plan.js';
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

export function withImplementation(frontmatter: string, title = '# Spec'): string {
  return `---\n${frontmatter}\n---\n${title}\n\n## Files / approach\nUpdate a scoped source file.\n`;
}

export async function runPlanOutputs(
  outputs: string[],
  issue: WorkKey,
  models: ModelsConfig,
  routes: RoutesConfig,
  tempDirs: Set<string>,
) {
  const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, `issue-${issue}.md`);
  const stub = new StubModelExecutor({ scripts: { plan: outputs.map((output) => ({ output })) } });
  const router = new ModelRouter(models, routes, false, stub);
  const { octokit } = fakeOctokit({
    'issues.get': { data: { title: 'Plan validity', body: 'Body.' } },
    'issues.listComments': { data: [] },
    'issues.createComment': (input: { body: string }) => ({ data: { id: 1, body: input.body } }),
    'users.getAuthenticated': { data: { id: 1 } },
  });
  const logs: Array<{ type: string; msg: string }> = [];
  const result = await planPhase({
    issue,
    repo: 'on-par/software-factory',
    worktree,
    specPath,
    router,
    constitution: null,
    octokit,
    log: (type, msg) => logs.push({ type, msg }),
  });
  return { result, logs, stub, octokit, worktree, specPath };
}
