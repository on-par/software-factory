import { describe, expect, it } from 'vitest';

import { fakePagedOctokit } from './fake-paged-octokit.js';
import { createOctokitQueueClient } from './github-queue.js';

describe('createOctokitQueueClient pagination (#3147)', () => {
  it('createOctokitQueueClient lists every page of a 150-member lane', async () => {
    const labels = new Map<number, string[]>();
    for (let n = 1; n <= 150; n++) labels.set(n, ['factory:queued', 'factory:lane:app', `factory:order:${n}`]);
    const { octokit, listPages } = fakePagedOctokit(labels);
    const issues = await createOctokitQueueClient(octokit).listOpenIssuesWithLabels({
      owner: 'o',
      repo: 'r',
      labels: ['factory:lane:app'],
    });
    expect(issues).toHaveLength(150);
    expect(listPages()).toBe(2);
  });
});
