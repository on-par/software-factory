import { createFakeGitHub } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';

import './index.js';
import { isLandLeftOpen, landOpenPullRequest } from './land-pr.js';

const MARKED =
  'Implements #1.\n\n<!-- factory:visual-proof v1 required -->\n### Visual proof\n<!-- /factory:visual-proof -->\n';
const status = (creatorId: number, state = 'success') => ({
  context: 'factory/visual-proof',
  state,
  creator: { id: creatorId },
});

function setup(body: string, statusesBySha: Record<string, unknown[]>) {
  const github = createFakeGitHub([
    ['GET /repos/o/r/pulls/2', () => ({ head: { sha: 'newhead' }, base: { ref: 'main' }, body })],
    ['PUT /repos/o/r/pulls/2/merge', () => ({ merged: true })],
    [/^DELETE \/repos\/o\/r\/git\/refs\//, () => ({})],
    ['GET /user', () => ({ id: 77, login: 'factory-bot', type: 'Bot' })],
    [/^GET \/repos\/o\/r\/commits\/[^/]+\/statuses/, (req) => statusesBySha[req.path.split('/')[5] ?? ''] ?? []],
    ['POST /graphql', () => ({ data: { repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } } })],
  ]);
  const merges = () => github.requests.filter((r) => r.method === 'PUT' && r.path === '/repos/o/r/pulls/2/merge');
  const logs: Array<[string, string]> = [];
  const land = () =>
    landOpenPullRequest({
      octokit: github.octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log: (kind: string, msg: string) => void logs.push([kind, msg]),
      skipCI: true,
      adminMerge: false,
      sleep: async () => {},
      run: async () => ({ stdout: '' }),
      behindProbe: async () => false,
    });
  return { land, merges, logs };
}

describe('landOpenPullRequest: UI visual proof (#2232)', () => {
  it.each([
    ['leaves the PR open when visual proof is for an older head', { oldhead: [status(77)] }],
    ['leaves the PR open when the status was not created by the factory', { newhead: [status(1)] }],
    ['leaves the PR open after a failed attach in required mode', { newhead: [status(77, 'failure')] }],
  ])('%s', async (_title, statuses: Record<string, unknown[]>) => {
    const { land, merges, logs } = setup(MARKED, statuses);
    const err = await land().catch((e: unknown) => e);
    expect(isLandLeftOpen(err)).toBe(true);
    expect(err).toMatchObject({ name: 'VisualProofMissingError', prNumber: 2 });
    expect(merges()).toEqual([]);
    const remedy = 're-run SHIP (factory resume --from ship) to capture proof for newhead';
    expect(logs).toContainEqual(['land', expect.stringContaining(remedy)]);
  });

  it('merges when the verified head has a factory-created visual proof status', async () => {
    const { land, merges } = setup(MARKED, { newhead: [status(77)] });
    await land();
    expect(merges()).toHaveLength(1);
  });

  it('merges a PR without the visual proof marker exactly as before', async () => {
    const { land, merges } = setup('Implements #1.', {});
    await land();
    expect(merges()).toHaveLength(1);
  });
});
