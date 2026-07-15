import { exec as execCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeFakeOctokit,
  makeStubModelsConfig,
  makeStubRoutesConfig,
  PipelineTestKit,
  specContentFor,
} from './index.js';

const exec = promisify(execCb);

const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('specContentFor', () => {
  it('includes claude route frontmatter and the issue number in the heading', () => {
    const content = specContentFor(41);
    expect(content).toContain('route: claude');
    expect(content).toContain('(#41)');
  });
});

describe('makeStubModelsConfig / makeStubRoutesConfig', () => {
  it('return fresh objects on each call', () => {
    expect(makeStubModelsConfig()).not.toBe(makeStubModelsConfig());
    expect(makeStubRoutesConfig()).not.toBe(makeStubRoutesConfig());
  });

  it('configure plan and build_claude routes on tier boss', () => {
    const routes = makeStubRoutesConfig();
    expect(routes.routes.plan).toEqual({ tier: 'boss', description: 'stub' });
    expect(routes.routes.build_claude).toEqual({ tier: 'boss', description: 'stub' });

    const models = makeStubModelsConfig();
    expect(models.tiers.boss).toEqual(['stub-model']);
  });
});

describe('makeFakeOctokit', () => {
  it('records calls and returns scripted responses', async () => {
    const { octokit, calls } = makeFakeOctokit({ 7: 'Seven' });

    const created1 = await octokit.rest.pulls.create({ head: 'a' } as any);
    const created2 = await octokit.rest.pulls.create({ head: 'b' } as any);
    expect(created1.data.number).toBe(101);
    expect(created2.data.number).toBe(102);

    const issue = await octokit.rest.issues.get({ issue_number: 7 } as any);
    expect(issue.data.title).toBe('Seven');

    const pull = await octokit.rest.pulls.get({ pull_number: 101 } as any);
    expect(pull.data).toEqual({ draft: true, node_id: 'PR_101' });

    await octokit.rest.pulls.list({} as any);
    await octokit.rest.checks.listForRef({} as any);
    await octokit.graphql('query markPullRequestReadyForReview {}', { id: 'PR_101' });

    expect(calls).toContainEqual(['pulls.create', { head: 'a' }]);
    expect(calls).toContainEqual(['pulls.create', { head: 'b' }]);
    expect(calls).toContainEqual(['issues.get', { issue_number: 7 }]);
    expect(calls).toContainEqual(['pulls.get', { pull_number: 101 }]);
    expect(calls).toContainEqual(['pulls.list', {}]);
    expect(calls).toContainEqual(['checks.listForRef', {}]);
    expect(calls).toContainEqual(['graphql', 'query markPullRequestReadyForReview {}', { id: 'PR_101' }]);
  });
});

describe('PipelineTestKit', () => {
  it('makeThrowawayRepo produces a repo whose origin has a main branch', async () => {
    const { origin, repoRoot } = await kit.makeThrowawayRepo();
    await expect(exec(`git -C '${origin}' rev-parse --verify refs/heads/main`)).resolves.toBeTruthy();
    expect(existsSync(repoRoot)).toBe(true);
  });

  it('trackWorktree returns the conventional worktree path', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const worktree = kit.trackWorktree(repoRoot, 34);
    expect(worktree).toBe(`${repoRoot}-wt-34`);
  });

  it('cleanup removes temp dirs created by the kit', async () => {
    const { origin, repoRoot } = await kit.makeThrowawayRepo();
    const specPath = await kit.makeSpecPath(34);

    await kit.cleanup();

    expect(existsSync(origin)).toBe(false);
    expect(existsSync(repoRoot)).toBe(false);
    expect(existsSync(specPath)).toBe(false);
  });
});
