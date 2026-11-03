import { renderPreviewReceipt } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { landBaseGate } from './land-base-gate.js';
import { landOpenPullRequest } from './land-pr.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const previewPassBody = `Implements #1.\n\n${renderPreviewReceipt({
  status: 'pass',
  evidence: {
    url: 'https://p.example.com/',
    headSha: 'pr'.padEnd(40, '0'),
    command: ['npm', 'run', 'smoke'],
    exitCode: 0,
    readyWaitMs: 1000,
    commandMs: 1000,
    durationMs: 2000,
    artifacts: [],
  },
})}\n`;

function redMainOctokit() {
  const merge = vi.fn(async () => ({ data: { merged: true } }));
  const rest = {
    pulls: {
      get: async () => ({
        data: { head: { sha: 'pr' }, base: { ref: 'main' }, body: previewPassBody, merge_commit_sha: 'merge' },
      }),
      merge,
    },
    git: { deleteRef: vi.fn() },
    repos: {
      getBranch: async () => ({ data: { commit: { sha: 'main-head' } } }),
      getStatusChecksProtection: async () => ({ data: { contexts: ['ci'] } }),
      getBranchRules: async () => ({ data: [] }),
      compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } }),
    },
    actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }) },
  };
  const graphql = async () => ({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } });
  const octokit: Octokit = Object.assign(Object.create(null), { graphql, rest });
  return { octokit, merge };
}

describe('landing after a preview pass', () => {
  it('still refuses to merge into a red main', async () => {
    const { octokit, merge } = redMainOctokit();
    const log = vi.fn();
    const baseGate = landBaseGate({ octokit, owner: 'o', repo: 'r', prNumber: 2, state: dirs.makeSync('land-'), log });
    const landing = landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log,
      skipCI: true,
      adminMerge: false,
      sleep: async () => {},
      run: vi.fn(),
      behindProbe: async () => false,
      baseGate,
    });
    await expect(landing).rejects.toThrow('failed');
    expect(merge).not.toHaveBeenCalled();
  });
});
