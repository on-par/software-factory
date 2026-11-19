import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
import { fakeOctokit } from '../test-support/fake-octokit.js';
import { cmdResult } from '../test-support/visual-proof-test-helpers.js';
import type { CommandResult } from '../utils/command-runner.js';
import { runIssue } from './run-issue.js';
import {
  type Log,
  listPrChangedFiles,
  policy,
  ports,
  request,
  resetCiReworkMocks,
  shipPhase,
  tmp,
} from './ci-rework-test-helpers.js';

beforeEach(resetCiReworkMocks);
afterAll(() => tmp.cleanup());

const VISUAL_PROOF = VisualProofConfigSchema.parse({
  uiPaths: ['web/**'],
  routes: [{ route: '/items', assert: '#item-1', paths: ['web/items/**'] }],
  command: ['node', 'scripts/capture.mjs'],
});
const HEAD = 'a'.repeat(40);

async function shipGate(config = VISUAL_PROOF, edit: Partial<CommandResult> = {}) {
  let shipOpts: Parameters<typeof shipPhase>[0] | undefined;
  shipPhase.mockImplementationOnce(async (opts) => {
    shipOpts = opts;
    return { ok: true, prNumber: 9 };
  });
  const { octokit, calls } = fakeOctokit();
  const git: string[] = [];
  octokit.rest.git = new Proxy({}, { get: (_, name) => (git.push(String(name)), async () => ({ data: {} })) });
  const gh: string[][] = [];
  const outDir = tmp.makeSync('ci-rework-visual-proof-');
  const viewport = { width: 1280, height: 800 };
  const captures = [{ route: '/items', state: 'default', viewport, finalPath: '/items', file: 'after.png', bytes: 4 }];
  await runIssue(request, policy, {
    ...ports(vi.fn<Log>()),
    octokit,
    loadVisualProofConfig: () => config,
    captureVisualProof: async ({ headSha, runId }) => ({ status: 'pass', headSha, runId, outDir, captures }),
    runGh: async (args) => {
      gh.push([...args]);
      return cmdResult(args[1] === '--version' ? { stdout: 'gh version 2.103.0 (2026-11-01)\n' } : edit);
    },
  });
  return { calls, git, gh, shipOpts, run: () => shipOpts?.visualProofGate?.({ prNumber: 9, headSha: HEAD }) };
}

describe('shipWithCiRework — visual proof gate always publishes (#4054)', () => {
  it('publishes an unavailable block when the visual proof gate throws', async () => {
    listPrChangedFiles.mockRejectedValueOnce(new Error('files lookup failed'));
    const { calls, gh, run } = await shipGate();
    expect(await run()).toMatchObject({ status: 'unavailable', diagnostic: 'files lookup failed' });
    expect(calls.pullsUpdate[0]?.body).toContain('Visual proof unavailable: files lookup failed');
    expect(calls.createCommitStatus.map((s) => s.state)).toEqual(['failure']);
    expect(gh).toEqual([]);
  });

  it('publishes a passing capture through gh attach without git blobs', async () => {
    listPrChangedFiles.mockResolvedValueOnce(['web/items/a.css']);
    const { calls, git, gh, run } = await shipGate();
    expect(await run()).toMatchObject({ status: 'pass', images: [{ url: './after.png' }] });
    expect(gh[1]?.slice(0, 4)).toEqual(['gh', 'pr', 'edit', '9']);
    expect(gh[1]).toContain('--attach');
    expect(git).toEqual([]);
    expect(calls.createCommitStatus.map((s) => s.state)).toEqual(['success']);
  });
});
