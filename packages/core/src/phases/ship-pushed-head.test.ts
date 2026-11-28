import { describe, expect, it, vi } from 'vitest';

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import { fakeOctokit } from '../test-support/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { shipPhase } from './ship.js';

const SHA = 'c0ffee'.padEnd(40, '1');
const BRANCH = 'ship-it/77-pushed-head';
const FAILING_RUN = { name: 'test (2/3)', status: 'completed', conclusion: 'failure' };

function octokitFor(openPr: boolean) {
  const { octokit } = fakeOctokit({
    graphql: async () => ({}),
    'pulls.list': async () => ({ data: openPr ? [{ number: 77 }] : [] }),
    'pulls.create': async () => ({ data: { number: 77 } }),
    'pulls.get': async () => ({ data: { draft: true, node_id: 'PR_1' } }),
    'issues.get': async () => ({ data: { title: 'Pushed head' } }),
    'issues.createComment': async () => ({ data: { id: 1 } }),
    'checks.listForRef': async () => ({ data: { check_runs: [FAILING_RUN] } }),
    'codeScanning.listAlertsForRepo': async () => ({ data: [] }),
  });
  return octokit;
}

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/${BRANCH}\n` };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

const previewFail = (pr: { prNumber: number; headSha: string }): Promise<PreviewCheckResult> =>
  Promise.resolve({
    status: 'fail',
    evidence: { headSha: pr.headSha, command: ['smoke'], readyWaitMs: 1, durationMs: 1, artifacts: [] },
  });

describe('shipPhase — a first ship records the pushed remote head (#4337)', () => {
  it.each([
    { path: 'a new branch', openPr: false, gate: 'CI', watchCI: true },
    { path: 'an already-open PR', openPr: true, gate: 'CI', watchCI: true },
    { path: 'a new branch', openPr: false, gate: 'preview', watchCI: false },
    { path: 'an already-open PR', openPr: true, gate: 'preview', watchCI: false },
  ])('a $gate failure on $path carries headSha equal to the pushed remote head', async ({ openPr, gate, watchCI }) => {
    const gated: string[] = [];
    const previewGate = async (pr: { prNumber: number; headSha: string }) => {
      gated.push(pr.headSha);
      return previewFail(pr);
    };
    vi.useFakeTimers();
    try {
      const promise = shipPhase({
        issue: workKeyFromIssue(77),
        repo: 'o/r',
        worktree: '/repo-77',
        branch: BRANCH,
        octokit: octokitFor(openPr),
        watchCI,
        log: () => {},
        run,
        ...(gate === 'preview' ? { previewGate } : {}),
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toMatchObject({ ok: false, prNumber: 77, headSha: SHA });
      expect(gated).toEqual(gate === 'preview' ? [SHA] : []);
      expect(result.ciOutcome).toBe(gate === 'CI' ? 'failure' : undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
