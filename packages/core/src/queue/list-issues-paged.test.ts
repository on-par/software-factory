// packages/core/src/queue/list-issues-paged.test.ts — paginated lane scan (#3147).

import { describe, expect, it } from 'vitest';

import { createOctokitQueueClient } from './github-queue.js';

describe('createOctokitQueueClient > listOpenIssuesWithLabels pagination', () => {
  it('paginates listOpenIssuesWithLabels so a 150-member lane is returned whole', async () => {
    const pages: number[] = [];
    const octokit: any = {
      rest: {
        issues: {
          listForRepo: async ({ page }: { page: number }) => {
            pages.push(page);
            const count = page === 1 ? 100 : 50;
            const data = Array.from({ length: count }, (_, i) => ({
              number: (page - 1) * 100 + i + 1,
              labels: ['factory:lane:a'],
            }));
            return { data };
          },
        },
      },
    };
    const result = await createOctokitQueueClient(octokit).listOpenIssuesWithLabels({
      owner: 'o',
      repo: 'r',
      labels: ['factory:lane:a'],
    });
    expect(result).toHaveLength(150);
    expect(pages).toEqual([1, 2]);
  });

  it('stops on a short raw page even when pull requests were filtered out of it', async () => {
    const pages: number[] = [];
    const octokit: any = {
      rest: {
        issues: {
          listForRepo: async ({ page }: { page: number }) => {
            pages.push(page);
            return {
              data:
                page === 1
                  ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, labels: [], pull_request: {} }))
                  : [],
            };
          },
        },
      },
    };
    const result = await createOctokitQueueClient(octokit).listOpenIssuesWithLabels({
      owner: 'o',
      repo: 'r',
      labels: ['x'],
    });
    expect(result).toEqual([]);
    expect(pages).toEqual([1, 2]);
  });
});
