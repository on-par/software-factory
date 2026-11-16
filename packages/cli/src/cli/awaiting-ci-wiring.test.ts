import { join } from 'node:path';

import { loadFactoryConfig, type FactoryConfig } from '@on-par/factory-core';
import { readAwaitingCi, upsertAwaitingCi } from '@on-par/factory-core/internal';
import { createTempDirs, fakeOctokit } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import './index.js';
import { awaitingCiLaneDeps } from './awaiting-ci-wiring.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

function ciOctokit(runs: unknown[], mergeFn = async (_p: unknown) => ({})) {
  return fakeOctokit({
    'pulls.get': async () => ({ data: { state: 'open', merged: false, head: { sha: 'sha1' }, base: { ref: 'main' } } }),
    'pulls.merge': mergeFn,
    'repos.getStatusChecksProtection': async () => ({ data: { contexts: [], checks: [] } }),
    'repos.getBranchRules': async () => ({ data: [] }),
    'checks.listForRef': async () => ({ data: { check_runs: runs } }),
    'git.deleteRef': async () => {},
  }).octokit;
}

describe('awaitingCiLaneDeps (#3208)', () => {
  const config = { ...loadFactoryConfig(), run: { merge: { auto: false, admin: false } } } as FactoryConfig;
  const rec = {
    issue: 4,
    prNumber: 8,
    branch: 'factory/4',
    headSha: 'old',
    firstSeenAt: Date.now() - 1000,
    attempts: 0,
    nextRecheckAt: 1,
  };

  it('records, then merges pinned to the head when all checks on head pass, warning once about protection', async () => {
    const state = dirs.makeSync('wiring-');
    const merges: unknown[] = [];
    const octokit = ciOctokit(
      [{ name: 'lint', status: 'completed', conclusion: 'success' }],
      async (p: unknown) => (merges.push(p), {}),
    );
    const deps = awaitingCiLaneDeps(() => octokit, 'o/wiring-repo', { state } as any, config);
    await deps.recordAwaitingCi!(rec);
    const emitted: unknown[][] = [];
    await deps.recheckAwaitingCi!({ park: async () => {}, emit: (...e) => emitted.push(e) });
    expect(merges).toEqual([expect.objectContaining({ pull_number: 8, sha: 'sha1', merge_method: 'squash' })]);
    expect(await readAwaitingCi(join(state, 'awaiting-ci.json'))).toEqual([]);
    expect(emitted).toContainEqual(['warn', 0, 'no branch protection on o/wiring-repo@main; using all checks on head']);
  });

  it('reschedules while no check run exists', async () => {
    const state = dirs.makeSync('wiring-');
    const deps = awaitingCiLaneDeps(() => ciOctokit([]), 'o/wiring-repo2', { state } as any, config);
    await upsertAwaitingCi(join(state, 'awaiting-ci.json'), rec);
    await deps.recheckAwaitingCi!({ park: async () => {}, emit: () => {} });
    expect((await readAwaitingCi(join(state, 'awaiting-ci.json')))[0]).toMatchObject({ attempts: 1, headSha: 'sha1' });
  });
});
