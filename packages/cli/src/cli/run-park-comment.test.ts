// packages/cli/src/cli/run-park-comment.test.ts — a queue preflight park on a remote factory run upserts the issue park comment (#3534)

import { rmSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('factory run park comment (#3534)', () => {
  it('a queue preflight park on a remote run upserts the issue park comment through the run octokit', async () => {
    rmSync(paths().queue, { force: true });
    const labels = new Set(['factory:queued', 'factory:lane:app', 'factory:order:1']);
    h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
      data: [{ number: 3600, title: 'Issue 3600', labels: [...labels] }],
    }));
    h.octokit.rest.issues.get = vi.fn(async ({ issue_number }: any) => ({
      data: { number: issue_number, title: `Issue ${issue_number}`, body: 'Prerequisite: #3599' },
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
});
