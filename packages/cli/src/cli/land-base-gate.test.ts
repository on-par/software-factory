import { createTempDirs, fakeOctokit } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { landBaseGate } from './land-base-gate.js';

const baseOctokit = (head: string, merge: string | null, status = 'ahead') => {
  const octokit = fakeOctokit({
    'pulls.get': async () => ({ data: { base: { ref: 'release' }, merge_commit_sha: merge } }),
    'repos.getBranch': async ({ branch }: { branch: string }) =>
      branch === 'release' ? { data: { commit: { sha: head } } } : Promise.reject(new Error('wrong base')),
    'repos.getStatusChecksProtection': async () => ({ data: { contexts: ['ci'] } }),
    'repos.getBranchRules': async () => ({ data: [] }),
    'repos.compareCommitsWithBasehead': async () => ({ data: { status } }),
    'checks.listForRef': async () => ({
      data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] },
    }),
    'actions.listWorkflowRunsForRepo': async () => ({ data: { workflow_runs: [] } }),
  }).octokit as never;
  return { octokit };
};

const noop = () => {};
const dirs = createTempDirs();
afterEach(() => dirs.cleanup());
const withState = (fn: (state: string) => Promise<void>) => fn(dirs.makeSync('base-gate-'));

describe('landing base lookup', () => {
  it('reads the actual base branch and records its merged commit', () =>
    withState(async (state) => {
      const { octokit } = baseOctokit('merge', 'merge');
      const events: string[] = [];
      const log = (kind: string, msg: string) => void events.push(`${kind}: ${msg}`);
      const gate = landBaseGate({ octokit, owner: 'o', repo: 'r', prNumber: 1, state, log });
      await gate.record();
      await expect(gate.check()).rejects.toThrow('failed');
      expect(events).toEqual([expect.stringMatching(/^red-main: .*merge/)]);
    }));
  it.each([
    ['ahead', 1],
    ['diverged', 0],
  ])('pauses only when the red base descends from the merge (%s)', (status, alerts) =>
    withState(async (state) => {
      const events: string[] = [];
      const log = (kind: string, msg: string) => void events.push(`${kind}: ${msg}`);
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
      expect(events).toHaveLength(alerts);
    }),
  );
  it('rejects recording a merge without a merge commit', () =>
    withState(async (state) => {
      const gate = landBaseGate({ ...baseOctokit('x', null), owner: 'o', repo: 'r', prNumber: 1, state, log: noop });
      await expect(gate.record()).rejects.toThrow('no merge commit');
    }));
});
