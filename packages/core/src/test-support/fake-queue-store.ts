import type { QueueGitHubClient, QueueIssue } from '../queue/github-queue.js';
import { fakeIssueComments } from '../queue/fake-issue-comments.js';

export interface FakeQueueStore {
  state: Map<number, Set<string>>;
  client: QueueGitHubClient;
  calls: string[];
  writes: string[];
  createdLabels: Set<string>;
  deletedRepoLabels: string[];
  repoLabelSet: Set<string>;
}

export function createFakeStore(
  issues: ReadonlyArray<{ number: number; labels: readonly string[] }>,
  repoLabels?: readonly string[],
): FakeQueueStore {
  const state = new Map<number, Set<string>>(issues.map((i) => [i.number, new Set(i.labels)]));
  const createdLabels = new Set<string>();
  const deletedRepoLabels: string[] = [];
  const repoLabelSet = new Set<string>(repoLabels ?? []);
  const calls: string[] = [];
  const writes: string[] = [];

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      calls.push('listOpenIssuesWithLabels');
      const result: QueueIssue[] = [];
      for (const [number, labelSet] of state) {
        if (labels.every((l) => labelSet.has(l))) {
          result.push({ number, labels: [...labelSet] });
        }
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      calls.push('getIssueLabels');
      return [...(state.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      calls.push('addLabels');
      writes.push(`add #${issue_number}`);
      await Promise.resolve();
      const set = state.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      state.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      calls.push('removeLabel');
      writes.push(`remove #${issue_number}:${name}`);
      state.get(issue_number)?.delete(name);
    },
    ...fakeIssueComments(),
    async ensureLabel({ name }) {
      calls.push('ensureLabel');
      createdLabels.add(name);
      return false;
    },
  };

  if (repoLabels !== undefined) {
    client.listRepoLabels = async () => [...repoLabelSet];
    client.deleteRepoLabel = async ({ name }) => {
      deletedRepoLabels.push(name);
      repoLabelSet.delete(name);
    };
    client.listAllOpenIssues = async () => [...state].map(([number, set]) => ({ number, labels: [...set] }));
  }

  return { state, client, calls, writes, createdLabels, deletedRepoLabels, repoLabelSet };
}
