// packages/cli/src/cli/test-support/unpark-client.ts — in-memory label-backed QueueGitHubClient for unpark contract tests.

import type { QueueGitHubClient } from '@on-par/factory-core/internal';

export function unparkClient(labels: Map<number, string[]>): QueueGitHubClient {
  return {
    listOpenIssuesWithLabels: async ({ labels: wanted }) =>
      [...labels.entries()]
        .filter(([, current]) => wanted.every((label) => current.includes(label)))
        .map(([number, current]) => ({ number, labels: [...current] })),
    getIssueLabels: async ({ issue_number }) => [...(labels.get(issue_number) ?? [])],
    addLabels: async ({ issue_number, labels: additions }) => {
      const current = labels.get(issue_number) ?? [];
      labels.set(issue_number, [...current, ...additions.filter((label) => !current.includes(label))]);
    },
    removeLabel: async ({ issue_number, name }) => {
      labels.set(
        issue_number,
        (labels.get(issue_number) ?? []).filter((label) => label !== name),
      );
    },
    ensureLabel: async () => false,
    createIssueComment: async () => ({ id: 1 }),
    listIssueComments: async () => [],
    deleteIssueComment: async () => {},
  };
}
