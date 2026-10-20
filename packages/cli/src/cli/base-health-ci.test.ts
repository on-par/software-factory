import { describe, expect, it, vi } from 'vitest';

import type { Octokit } from '@octokit/rest';
import { baseHealthWithCi } from './base-health-ci.js';

describe('baseHealthWithCi push fallback', () => {
  it('uses successful push suites when protection and rules endpoints return 403', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    const octokit = Object.assign({
      rest: {
        repos: {
          getStatusChecksProtection: vi.fn(async () => {
            throw forbidden;
          }),
          getBranchRules: vi.fn(async () => {
            throw forbidden;
          }),
        },
        checks: {
          listForRef: vi.fn(async () => ({
            data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 7 } }] },
          })),
        },
        actions: {
          listWorkflowRunsForRepo: vi.fn(async () => ({ data: { workflow_runs: [{ check_suite_id: 7 }] } })),
        },
      },
    }) as Octokit;
    const runBaseline = vi.fn(async () => ({
      baseSha: 'a'.repeat(40),
      checkers: [
        {
          checker: 'compile',
          verdict: 'fails-on-base' as const,
          baseResult: 'FAIL' as const,
          baseTimedOut: true as const,
        },
      ],
    }));
    const health = baseHealthWithCi(octokit, 'owner', 'repo');
    const result = await health({
      worktree: '/tmp/wt',
      constitution: null,
      router: {} as never,
      env: {},
      log: () => {},
      deps: {
        runBaseline: runBaseline as never,
        runCommand: vi.fn(async () => ({
          command: [],
          stdout: `${'a'.repeat(40)}\n`,
          stderr: '',
          exitCode: 0,
          killed: false,
          timedOut: false,
          ok: true,
        })),
      },
    });
    expect(result.kind).toBe('green');
    expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ head_sha: 'a'.repeat(40), event: 'push' }),
    );
  });
});
