// packages/cli/src/cli/run-park-comment.test.ts — a queue preflight park on a remote factory run upserts the issue park comment (#3534)

import { rmSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, ops, paths, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

// One remote-queued issue on lane 'app', with label writes reflected back to the queue reads.
function queueIssue(issue: number, body: string): void {
  rmSync(paths().queue, { force: true });
  const labels = new Set(['factory:queued', 'factory:lane:app', 'factory:order:1']);
  h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
    data: [{ number: issue, title: `Issue ${issue}`, labels: [...labels] }],
  }));
  h.octokit.rest.issues.get = vi.fn(async ({ issue_number }: any) => ({
    data: { number: issue_number, title: `Issue ${issue_number}`, body },
  }));
  h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [...labels].map((name) => ({ name })) }));
  h.octokit.rest.issues.listLabelsForRepo = vi.fn(async () => ({ data: [] }));
  h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
  h.octokit.rest.issues.addLabels = vi.fn(async ({ labels: added }: any) => {
    for (const name of added) labels.add(name);
    return {};
  });
  h.octokit.rest.issues.removeLabel = vi.fn(async ({ name }: any) => {
    labels.delete(name);
    return {};
  });
  h.octokit.rest.issues.createComment = vi.fn(async () => ({ data: { id: 1 } }));
  h.octokit.paginate = async (fn: any, args: any) => (await fn(args)).data;
}

describe('factory run park comment (#3534)', () => {
  it('a queue preflight park on a remote run upserts the issue park comment through the run octokit', async () => {
    queueIssue(3600, 'Prerequisite: #3599');
    h.octokit.graphql = vi.fn(async (query: string) =>
      query.includes('QueuePrerequisite')
        ? {
            repository: {
              issue: {
                state: 'CLOSED',
                closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          }
        : { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } },
    );

    const res = await runMain('run');
    expect(res.exited).toBe(false);
    expect(h.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const [comment] = h.octokit.rest.issues.createComment.mock.calls[0];
    expect(comment.issue_number).toBe(3600);
    expect(comment.body).toContain('<!-- factory-issue-state v1 issue:3600 -->');
    expect(comment.body).toContain('reason: escalate');
    expect(comment.body).toContain('prerequisite #3599 closed unmerged');
  });

  it('a land-time ci-failed park reads the park sha from the pushed origin branch', async () => {
    const branch = 'factory/3601-issue-3601';
    queueIssue(3601, 'b');
    h.factoryConfig.merge = { auto: true, comment: '' };
    h.factoryConfig.filing = {
      enabled: false,
      excludeReasons: [],
      selfFixLabel: 'no-auto-merge',
      bugLabels: [],
      sensitivePaths: [],
    };
    // The PR exists only once the ship phase opened it, so the queue preflight sees no PR to adopt.
    let opened = false;
    phases.shipPhase.mockImplementation(async () => {
      opened = true;
      return h.shipResult;
    });
    h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
      state === 'open' && opened
        ? {
            data: [{ number: 99, head: { ref: branch, repo: { full_name: h.ghRepo } }, body: 'Closes #3601' }],
          }
        : { data: [] },
    );
    h.octokit.rest.pulls.listFiles = vi.fn(async () => ({ data: [] }));
    h.octokit.rest.pulls.update = vi.fn(async () => ({}));
    // The CI watch cannot read the PR head, so the land refuses to merge without a green verdict.
    h.octokit.rest.pulls.get = vi.fn(async () => {
      throw new Error('checks api down');
    });
    h.execImpl = (cmd: string) => {
      if (cmd.includes('refs/remotes/origin/')) return '  0123abcd\n';
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('gh repo view')) return h.ghRepo;
      return '';
    };

    const res = await runMainWith({ loadRepoConfig: () => ({ classifier: { trustTier: 'T2' } }) as never }, 'run');
    expect(res.exited).toBe(false);
    expect(ops.exec).toHaveBeenCalledWith(`git rev-parse --verify "refs/remotes/origin/${branch}"`, {
      cwd: h.repoRoot,
    });
    const park = h.octokit.rest.issues.createComment.mock.calls
      .map(([c]: any) => c)
      .find((c: any) => c.body.includes('<!-- factory-issue-state v1 issue:3601 -->'));
    expect(park?.issue_number).toBe(3601);
    expect(park?.body).toContain('reason: ci-failed');
    expect(park?.body).toContain(`branch: ${branch}`);
    expect(park?.body).toMatch(/^park-sha: 0123abcd$/m);
  });
});
