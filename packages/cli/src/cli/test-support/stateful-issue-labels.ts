// packages/cli/src/cli/stateful-issue-labels.ts — test double: an octokit `issues` mock whose label reads reflect earlier addLabels writes, as enqueue's post-write verify expects (#3147).

import { vi } from 'vitest';

export function statefulIssueLabels(base: Record<number, string[]> = {}, failAddOn?: number) {
  const labels = new Map<number, string[]>(Object.entries(base).map(([n, l]) => [Number(n), l]));
  const addLabels = vi.fn(async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
    if (issue_number === failAddOn) throw new Error('label API down');
    labels.set(issue_number, [...(labels.get(issue_number) ?? []), ...add]);
    return {};
  });
  const listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
    data: (labels.get(issue_number) ?? []).map((name) => ({ name })),
  }));
  return { addLabels, listLabelsOnIssue };
}
