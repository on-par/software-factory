import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
import {
  listPrChangedFiles,
  type Log,
  policy,
  ports,
  request,
  resetCiReworkMocks,
  shipPhase,
  tmp,
} from './ci-rework-test-helpers.js';
import { runIssue } from './run-issue.js';
import type { ShipPhaseOptions } from '../phases/ship-options.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

describe('shipWithCiRework — visual proof gate always publishes (#4054)', () => {
  const VISUAL_PROOF = VisualProofConfigSchema.parse({
    uiPaths: ['app/**'],
    routes: [{ route: '/items', assert: '#item-1', paths: ['app/items/**'] }],
    command: ['node', 'scripts/capture.mjs'],
  });

  const recordingOctokit = () => {
    const bodies: string[] = [];
    const statuses: { state: string; description: string }[] = [];
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
          createCommitStatus: async (args: { state: string; description: string }) => {
            statuses.push(args);
            return {};
          },
        },
      },
    };
    return { octokit, bodies, statuses };
  };

  const captureGate = async (octokit: unknown, loadVisualProofConfig: () => typeof VISUAL_PROOF) => {
    let gate: ShipPhaseOptions['visualProofGate'];
    shipPhase.mockImplementationOnce(async (opts: ShipPhaseOptions) => {
      gate = opts.visualProofGate;
      return { ok: true, prNumber: 9 };
    });
    await runIssue(request, policy, { ...ports(vi.fn<Log>()), octokit: octokit as never, loadVisualProofConfig });
    if (!gate) throw new Error('expected a visualProofGate');
    return gate;
  };

  it('publishes an unavailable block when the visual proof gate throws', async () => {
    const { octokit, bodies, statuses } = recordingOctokit();
    vi.mocked(listPrChangedFiles).mockRejectedValueOnce(new Error('github is down'));
    const gate = await captureGate(octokit, () => VISUAL_PROOF);
    const result = await gate({ prNumber: 9, headSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: 'github is down' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Visual proof unavailable: github is down');
    expect(statuses[0]).toMatchObject({ state: 'failure', description: 'github is down' });
  });

  it('does not publish anything when no proof is required', async () => {
    const { octokit, bodies, statuses } = recordingOctokit();
    const gate = await captureGate(octokit, () => VISUAL_PROOF);
    expect(await gate({ prNumber: 9, headSha: 'a'.repeat(40) })).toMatchObject({ status: 'not-required' });
    expect(bodies).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
