import { describe, expect, it, vi } from 'vitest';

import type { BaseHealthOptions } from '@on-par/factory-core/internal';

import { baseHealthWithCi } from './base-health-ci.js';

describe('baseHealthWithCi', () => {
  it('passes configured names, CI fallback and the base-health logger to the shared verdict', async () => {
    const sha = 'd'.repeat(40);
    const log = vi.fn();
    const listForRef = vi.fn(async () => ({
      data: {
        check_runs: [
          { name: 'contract', status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
          { name: 'release', status: 'completed', conclusion: 'failure', check_suite: { id: 2 } },
        ],
      },
    }));
    const listWorkflowRunsForRepo = vi.fn(async () => ({
      data: {
        workflow_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', id: 1, check_suite_id: 1 },
          { name: 'Release', status: 'completed', conclusion: 'failure', id: 2, check_suite_id: 2 },
        ],
      },
    }));
    const octokit = {
      rest: {
        checks: { listForRef },
        actions: { listWorkflowRunsForRepo },
      },
    } as never;
    const runBaseline = vi.fn(
      async () =>
        ({
          baseSha: sha,
          checkers: [{ checker: 'compile', verdict: 'fails-on-base', baseTimedOut: true }],
        }) as never,
    );
    const check = baseHealthWithCi(octokit, 'owner', 'repo', ['contract']);
    const options: BaseHealthOptions = {
      worktree: '/tmp/worktree',
      constitution: null,
      router: {} as never,
      env: {},
      log,
      deps: {
        runCommand: vi.fn(async () => ({
          command: ['git', 'rev-parse'],
          exitCode: 0,
          stdout: sha,
          stderr: '',
          killed: false,
          timedOut: false,
          ok: true,
        })),
        runBaseline,
        memo: new Map(),
      },
    };

    const result = await check(options);

    expect(result.kind).toBe('green');
    expect(listForRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: sha,
      per_page: 100,
      filter: 'latest',
    });
    expect(listWorkflowRunsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', head_sha: sha, event: 'push' }),
    );
    expect(log).toHaveBeenCalledWith('base_push_workflow_failed', expect.stringContaining('Release'));
    expect(log.mock.calls.some(([type]) => type === 'check')).toBe(true);
  });
});
