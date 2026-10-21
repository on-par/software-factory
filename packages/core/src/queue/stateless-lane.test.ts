// packages/core/src/queue/stateless-lane.test.ts — Lane-labelled issues with no state label (#3426).

import { describe, expect, it, vi } from 'vitest';

import {
  claimExpiresLabel,
  IN_PROGRESS_LABEL,
  PARKED_LABEL,
  QUEUED_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import type { LabelListClient } from './label-cache.js';
import { findStatelessLaneIssues, listRepoLaneLabels, listStatelessLaneIssues } from './stateless-lane.js';

function labelClient(names: string[]): LabelListClient {
  return {
    rest: {
      issues: {
        listLabelsForRepo: vi.fn(async ({ page }: { page: number }) => ({
          data: names.slice((page - 1) * 100, page * 100).map((name) => ({ name })),
        })),
      },
    },
  };
}

describe('reconcile: lane-labelled issues with no state label', () => {
  it('flags the #267 label set (enhancement, ios, factory:lane:mac-v1, factory:claim-expires:*)', () => {
    const found = findStatelessLaneIssues([
      {
        number: 267,
        labels: ['enhancement', 'ios', 'factory:lane:mac-v1', claimExpiresLabel(1_700_000_000)],
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ issue: 267, lanes: ['mac-v1'] });
  });

  it('does not flag queued, parked, in-progress or lane-less issues', () => {
    const lane = 'factory:lane:web';
    expect(
      findStatelessLaneIssues([
        { number: 1, labels: [lane, QUEUED_LABEL] },
        { number: 2, labels: [lane, PARKED_LABEL] },
        { number: 3, labels: [lane, IN_PROGRESS_LABEL] },
        { number: 4, labels: ['enhancement'] },
      ]),
    ).toEqual([]);
  });

  it('ignores an empty factory:lane: slug', () => {
    expect(findStatelessLaneIssues([{ number: 1, labels: ['factory:lane:'] }])).toEqual([]);
  });

  it('keeps the title when present', () => {
    const found = findStatelessLaneIssues([{ number: 1, labels: ['factory:lane:a'], title: 'T' }]);
    expect(found[0].title).toBe('T');
  });

  it('listStatelessLaneIssues lists each repo lane label once and dedupes issues across lanes', async () => {
    const issues: QueueIssue[] = [
      { number: 267, labels: ['factory:lane:mac-v1', 'factory:lane:web'] },
      { number: 5, labels: ['factory:lane:web', QUEUED_LABEL] },
    ];
    const listOpenIssuesWithLabels = vi.fn(async ({ labels }: { labels: string[] }) =>
      issues.filter((i) => labels.every((l) => i.labels.includes(l))),
    );
    const found = await listStatelessLaneIssues({
      client: { listOpenIssuesWithLabels } as Pick<QueueGitHubClient, 'listOpenIssuesWithLabels'>,
      labelClient: labelClient(['factory:lane:mac-v1', 'factory:lane:web', QUEUED_LABEL, 'bug']),
      owner: 'o',
      repo: 'r',
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ issue: 267, lanes: ['mac-v1', 'web'] });
    expect(listOpenIssuesWithLabels.mock.calls.map(([arg]) => arg.labels)).toEqual([
      ['factory:lane:mac-v1'],
      ['factory:lane:web'],
    ]);
  });

  it('listRepoLaneLabels pages until a short page and throws when the API fails', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `filler-${i}`).concat(['factory:lane:late', 'factory:lane:']);
    const client = labelClient(names);
    expect(await listRepoLaneLabels(client, 'o', 'r')).toEqual(['factory:lane:late']);
    expect(client.rest.issues.listLabelsForRepo).toHaveBeenCalledTimes(2);

    const failing: LabelListClient = {
      rest: {
        issues: {
          listLabelsForRepo: async () => {
            throw new Error('boom');
          },
        },
      },
    };
    await expect(listRepoLaneLabels(failing, 'o', 'r')).rejects.toThrow('boom');
    await expect(listRepoLaneLabels({ rest: { issues: {} } }, 'o', 'r')).rejects.toThrow('label listing unavailable');
  });
});
