import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';

import { planPhase } from '../phases/plan.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { makeStubModelsConfig, makeStubRoutesConfig, specContentFor } from './index.js';

// The *.integration.test.ts suites only run nightly (#755), and each scripts exactly one plan step
// with specContentFor(). This required-CI test pins that contract: if PLAN ever needs a second
// planner call for that spec (as #2809's design-artifact re-prompt did), it fails here, on the PR,
// instead of turning the nightly red.
const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

describe('specContentFor() against PLAN', () => {
  it('plans in one scripted step with a valid design artifact and no re-prompt', async () => {
    const issue = 34;
    const worktree = await tempDirs.make('spec-content-plan-');
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: specContentFor(issue) }] } });
    const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
    const octokit: any = {
      rest: { issues: { get: async () => ({ data: { title: 'Pipeline integration test', body: 'Body.' } }) } },
    };
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await planPhase({
      issue: workKeyFromIssue(issue),
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, `issue-${issue}.md`),
      router,
      constitution: null,
      octokit,
      log: (type, msg) => logs.push({ type, msg }),
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe('claude');
    expect(result.designArtifact).not.toBeNull();
    expect(stub.calls.filter((call) => call.task === 'plan')).toHaveLength(1);
    expect(logs.some((l) => l.msg.includes('design artifact invalid'))).toBe(false);
    expect(logs.some((l) => l.type === 'design_artifact_invalid')).toBe(false);
  });
});
