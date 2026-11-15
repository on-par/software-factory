import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
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

describe('shipWithCiRework — visual proof gate always publishes (#4054)', () => {
  const VISUAL_PROOF = VisualProofConfigSchema.parse({
    uiPaths: ['web/**'],
    routes: [{ route: '/items', assert: '#item-1', paths: ['web/items/**'] }],
    command: ['node', 'scripts/capture.mjs'],
  });

  it('publishes an unavailable block when the visual proof gate throws', async () => {
    let gate: ((pr: { prNumber: number; headSha: string }) => Promise<unknown>) | undefined;
    shipPhase.mockImplementationOnce(async (opts) => {
      gate = opts.visualProofGate;
      return { ok: true, prNumber: 9 };
    });
    listPrChangedFiles.mockRejectedValueOnce(new Error('files lookup failed'));
    const bodies: string[] = [];
    const statuses: string[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          get: async () => ({ data: { body: 'Original body' } }),
          update: async (args: { body: string }) => {
            bodies.push(args.body);
            return {};
          },
        },
        repos: {
          createCommitStatus: async (args: { state: string }) => {
            statuses.push(args.state);
            return {};
          },
        },
      },
    };
    await runIssue(request, policy, { ...ports(vi.fn<Log>()), octokit, loadVisualProofConfig: () => VISUAL_PROOF });
    if (!gate) throw new Error('expected a visualProofGate');
    const result = await gate({ prNumber: 9, headSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: 'files lookup failed' });
    expect(bodies[0]).toContain('Visual proof unavailable: files lookup failed');
    expect(statuses).toEqual(['failure']);
  });
});
