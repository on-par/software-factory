// packages/core/src/queue/queue-backend-sequence.test.ts — the GitHub label/comment call sequence is unchanged by the WorkKey queue seam (#3890).

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { QueueReleaseOutcome } from './github-queue.js';
import { createGithubQueue, laneLabel, QUEUED_LABEL, queueOrderLabel, type QueueGitHubClient } from './github-queue.js';
import { fakeIssueComments } from './fake-issue-comments.js';
import { createQueueBackend } from './queue-backend.js';

const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/lane-label-sequence.json', import.meta.url), 'utf-8'),
);

function createRecordingClient() {
  const state = new Map<number, Set<string>>([
    [101, new Set([QUEUED_LABEL, laneLabel('build'), queueOrderLabel(1)])],
    [102, new Set([QUEUED_LABEL, laneLabel('build'), queueOrderLabel(2)])],
  ]);
  const calls: unknown[][] = [];
  const comments = fakeIssueComments();

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      return [...state]
        .filter(([, set]) => labels.every((l) => set.has(l)))
        .map(([number, set]) => ({ number, labels: [...set] }));
    },
    async getIssueLabels({ issue_number }) {
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      calls.push(['addLabels', issue_number, labels]);
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      calls.push(['removeLabel', issue_number, name]);
      state.get(issue_number)?.delete(name);
    },
    ...comments,
    async createIssueComment(params) {
      calls.push(['createIssueComment', params.issue_number, params.body]);
      return comments.createIssueComment(params);
    },
    async deleteIssueComment(params) {
      calls.push(['deleteIssueComment', params.comment_id]);
      return comments.deleteIssueComment(params);
    },
    async ensureLabel() {
      return false;
    },
  };
  return { client, calls };
}

const queueOptions = { owner: 'o', repo: 'r', claimantId: 'aaa-1', now, claimSettleMs: 0 };

async function runDirect(): Promise<unknown[][]> {
  const { client, calls } = createRecordingClient();
  const queue = createGithubQueue({ client, ...queueOptions });
  const outcomes: QueueReleaseOutcome[] = ['done', 'queued'];
  for (const outcome of outcomes) {
    const claim = await queue.claimNext('build');
    if (claim === null) throw new Error('expected a claim');
    await queue.heartbeat(claim.issue);
    await queue.release(claim.issue, outcome);
  }
  return calls;
}

describe('queue seam call sequence (#3890)', () => {
  it('the unmodified GithubQueue still produces the recorded sequence', async () => {
    expect(await runDirect()).toEqual(fixture);
  });

  it('two queued issues claimed, heartbeated and released through the seam match the recorded sequence', async () => {
    const { client, calls } = createRecordingClient();
    const backend = createQueueBackend({ kind: 'github', github: { client, ...queueOptions } });
    const outcomes: QueueReleaseOutcome[] = ['done', 'queued'];
    for (const outcome of outcomes) {
      const claim = await backend.claimNext('build');
      if (claim === null) throw new Error('expected a claim');
      await backend.heartbeat(claim.key);
      await backend.release(claim.key, outcome);
    }
    expect(calls).toEqual(fixture);
  });
});
