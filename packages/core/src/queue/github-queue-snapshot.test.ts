import { describe, expect, it, vi } from 'vitest';

import { type QueueIssue, readGithubQueueSnapshot } from './github-queue.js';

function clientWith(issues: QueueIssue[]) {
  const listOpenIssuesWithLabels = vi.fn(async () => issues);
  return { client: { listOpenIssuesWithLabels }, listOpenIssuesWithLabels };
}

describe('readGithubQueueSnapshot (#1362)', () => {
  it('lists queued issues grouped by lane, in order-label order, with titles', async () => {
    const { client, listOpenIssuesWithLabels } = clientWith([
      { number: 12, title: 'Second in cleanup', labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:2'] },
      { number: 7, title: 'First in access', labels: ['factory:queued', 'factory:lane:access', 'factory:order:1'] },
      { number: 11, title: 'First in cleanup', labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:1'] },
    ]);

    const snapshot = await readGithubQueueSnapshot({ client, owner: 'o', repo: 'r' });

    expect(listOpenIssuesWithLabels).toHaveBeenCalledTimes(1);
    expect(listOpenIssuesWithLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', labels: ['factory:queued'] });
    expect(snapshot).toEqual({
      entries: [
        { lane: 'access', issue: 7, title: 'First in access', status: 'queued' },
        { lane: 'cleanup', issue: 11, title: 'First in cleanup', status: 'queued' },
        { lane: 'cleanup', issue: 12, title: 'Second in cleanup', status: 'queued' },
      ],
    });
  });

  it('derives in-progress + claimant and parked from labels, and omits a missing title', async () => {
    const { client } = clientWith([
      {
        number: 1,
        labels: [
          'factory:queued',
          'factory:lane:ops',
          'factory:order:1',
          'factory:in-progress',
          'factory:claimed-by:mini-123',
        ],
      },
      { number: 2, labels: ['factory:queued', 'factory:lane:ops', 'factory:order:2', 'factory:in-progress'] },
      { number: 3, labels: ['factory:queued', 'factory:lane:ops', 'factory:order:3', 'factory:parked'] },
    ]);

    const { entries } = await readGithubQueueSnapshot({ client, owner: 'o', repo: 'r' });

    expect(entries).toEqual([
      { lane: 'ops', issue: 1, status: 'in-progress', claimant: 'mini-123' },
      { lane: 'ops', issue: 2, status: 'in-progress' },
      { lane: 'ops', issue: 3, status: 'parked' },
    ]);
    expect(entries.every((e) => !('title' in e))).toBe(true);
  });

  it('returns no entries when nothing is queued or the queued issues carry no lane label', async () => {
    expect(await readGithubQueueSnapshot({ ...clientWith([]), owner: 'o', repo: 'r' })).toEqual({ entries: [] });
    expect(
      await readGithubQueueSnapshot({
        ...clientWith([{ number: 5, labels: ['factory:queued', 'factory:order:1', 'factory:lane:'] }]),
        owner: 'o',
        repo: 'r',
      }),
    ).toEqual({ entries: [] });
  });

  it('throws the same malformed-order-label error GithubQueue.list() throws', async () => {
    const { client } = clientWith([{ number: 9, labels: ['factory:queued', 'factory:lane:ops'] }]);
    await expect(readGithubQueueSnapshot({ client, owner: 'o', repo: 'r' })).rejects.toThrow(
      'invalid GitHub queue state for lane ops: issue #9 must have exactly one queue order label',
    );
  });
});
