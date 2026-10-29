import { describe, expect, it } from 'vitest';

import { createSimOctokit } from './octokit.js';
import type { SimClock } from './latency.js';

function recordingClock(random = 0.5): SimClock & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => random,
  };
}

describe('createSimOctokit', () => {
  it('matches makeFakeOctokit defaults', async () => {
    const { octokit, calls } = createSimOctokit({ titles: { 34: 'Fix the bug' } });

    await expect(octokit.rest.issues.get({ issue_number: 34 })).resolves.toEqual({
      data: { title: 'Fix the bug', body: 'stub issue body' },
    });
    await expect(octokit.rest.issues.update({ issue_number: 34, body: 'Updated body' })).resolves.toEqual({ data: {} });
    await expect(octokit.rest.pulls.list({})).resolves.toEqual({ data: [] });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 101 } });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 102 } });
    await expect(octokit.rest.pulls.get({ pull_number: 101 })).resolves.toEqual({
      data: { draft: true, node_id: 'PR_101' },
    });
    await expect(octokit.rest.checks.listForRef({})).resolves.toEqual({ data: { check_runs: [] } });
    await expect(octokit.graphql('query', {})).resolves.toEqual({
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    });

    expect(calls).toEqual([
      ['issues.get', { issue_number: 34 }],
      ['issues.update', { issue_number: 34, body: 'Updated body' }],
      ['pulls.list', {}],
      ['pulls.create', {}],
      ['pulls.create', {}],
      ['pulls.get', { pull_number: 101 }],
      ['checks.listForRef', {}],
      ['graphql', 'query', {}],
    ]);
  });

  it('defaults an unconfigured issue body to "stub issue body"', async () => {
    const { octokit } = createSimOctokit({ titles: { 1: 'Title only' } });
    await expect(octokit.rest.issues.get({ issue_number: 1 })).resolves.toEqual({
      data: { title: 'Title only', body: 'stub issue body' },
    });
  });

  it('honors a configured body', async () => {
    const { octokit } = createSimOctokit({ titles: { 1: 'Title' }, bodies: { 1: 'Custom body' } });
    await expect(octokit.rest.issues.get({ issue_number: 1 })).resolves.toEqual({
      data: { title: 'Title', body: 'Custom body' },
    });
  });

  it('starts pulls.create numbering at firstPrNumber', async () => {
    const { octokit } = createSimOctokit({ firstPrNumber: 500 });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 500 } });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 501 } });
  });

  it('returns a scripted response for the first call then falls back to default numbering', async () => {
    const { octokit } = createSimOctokit({
      endpoints: { 'pulls.create': [{ response: { data: { number: 7 } } }] },
    });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 7 } });
    await expect(octokit.rest.pulls.create({})).resolves.toEqual({ data: { number: 101 } });
  });

  it('rejects with an Error for a string fail spec, recording the call', async () => {
    const { octokit, calls } = createSimOctokit({
      endpoints: { 'issues.get': [{ fail: 'rate limited' }] },
    });
    await expect(octokit.rest.issues.get({ issue_number: 1 })).rejects.toThrow('rate limited');
    expect(calls).toEqual([['issues.get', { issue_number: 1 }]]);
  });

  it('rejects with the exact Error instance for an Error fail spec', async () => {
    const boom = new Error('boom');
    const { octokit } = createSimOctokit({ endpoints: { 'issues.get': [{ fail: boom }] } });
    await expect(octokit.rest.issues.get({ issue_number: 1 })).rejects.toBe(boom);
  });

  it('applies an executor-wide latency and a per-endpoint override', async () => {
    const clock = recordingClock();
    const { octokit } = createSimOctokit({
      latency: { fixedMs: 30 },
      endpoints: { 'pulls.list': [{ latency: { fixedMs: 5 } }] },
      clock,
    });

    await octokit.rest.pulls.list({});
    await octokit.rest.issues.get({ issue_number: 1 });

    expect(clock.slept).toEqual([5, 30]);
  });
});
