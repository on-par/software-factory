import { vi } from 'vitest';
import { openPrFixture } from './open-pr.js';

export function defaultOctokit() {
  return {
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
      },
      pulls: {
        list: vi.fn(async ({ state, head }: { state: string; head: string }) => ({
          data: state === 'open' ? [openPrFixture(head)] : [],
        })),
        get: vi.fn(async () => ({
          data: { head: { sha: 'abc123' }, base: { ref: 'main' }, merge_commit_sha: 'merged' },
        })),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: 'base' } } })),
        getStatusChecksProtection: vi.fn(async () => ({ data: { contexts: [] } })),
        getBranchRules: vi.fn(async () => ({ data: [] })),
      },
      actions: { listWorkflowRunsForRepo: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  };
}
