import { createTempDirs, fakeOctokit } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { landBaseGate } from './land-base-gate.js';

const baseOctokit = (head: string, merge: string | null, status = 'ahead') => {
  const getBranch = vi.fn(async () => ({ data: { commit: { sha: head } } }));
  const octokit = fakeOctokit({
    'pulls.get': async () => ({ data: { base: { ref: 'release' }, merge_commit_sha: merge } }),
    'repos.getBranch': getBranch,
    'repos.getStatusChecksProtection': async () => ({ data: { contexts: ['ci'] } }),
    'repos.getBranchRules': async () => ({ data: [] }),
    'repos.compareCommitsWithBasehead': async () => ({ data: { status } }),
    'checks.listForRef': async () => ({
      data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] },
    }),
    'actions.listWorkflowRunsForRepo': async () => ({ data: { workflow_runs: [] } }),
  }).octokit as never;
  return { octokit, getBranch };
};

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());
const withState = (fn: (state: string) => Promise<void>) => fn(dirs.makeSync('base-gate-'));

describe('landing base lookup', () => {
  it('reads the actual base branch and records its merged commit', () =>
    withState(async (state) => {
      const { octokit, getBranch } = baseOctokit('merge', 'merge');
      const log = vi.fn();
      const gate = landBaseGate({ octokit, owner: 'o', repo: 'r', prNumber: 1, state, log });
      await gate.record();
      await expect(gate.check()).rejects.toThrow('failed');
      expect(getBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'release' }));
      expect(log).toHaveBeenCalledWith('red-main', expect.stringContaining('merge'));
    }));
  it.each([
    ['ahead', 1],
    ['diverged', 0],
  ])('pauses only when the red base descends from the merge (%s)', (status, alerts) =>
    withState(async (state) => {
      const log = vi.fn();
      const gate = landBaseGate({
        ...baseOctokit('child', 'merge', status),
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        state,
        log,
      });
      await gate.record();
      await expect(gate.check()).rejects.toThrow('failed');
      expect(log).toHaveBeenCalledTimes(alerts);
    }),
  );
  it('rejects recording a merge without a merge commit', () =>
    withState(async (state) => {
      const gate = landBaseGate({ ...baseOctokit('x', null), owner: 'o', repo: 'r', prNumber: 1, state, log: vi.fn() });
      await expect(gate.record()).rejects.toThrow('no merge commit');
    }));
});
