// packages/cli/src/cli/test-support/stateful-label-fakes.ts — octokit label fakes that remember what addLabels wrote.
// The enqueue settle step re-reads an issue's labels after writing them (#3147), so a static `[]` read-back fails it.

import { vi } from 'vitest';

export function statefulLabelFakes() {
  const state = new Map<number, string[]>();
  return {
    addLabels: vi.fn(async ({ issue_number, labels }: { issue_number: number; labels: string[] }) => {
      state.set(issue_number, [...(state.get(issue_number) ?? []), ...labels]);
      return {};
    }),
    listLabelsOnIssue: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
      data: (state.get(issue_number) ?? []).map((name) => ({ name })),
    })),
  };
}
