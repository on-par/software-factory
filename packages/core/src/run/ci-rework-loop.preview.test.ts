import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PreviewConfigSchema } from '../config/preview-section.js';
import type { ShipResult } from '../phases/ship.js';
import { CHECK_OK, policy, ports, readReworkDiff, request, resetCiReworkMocks, tmp } from './ci-rework-test-helpers.js';
import { runIssue, type RunPorts } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

describe('shipWithCiRework — preview gate (#3880)', () => {
  const PREVIEW = PreviewConfigSchema.parse({ source: { kind: 'deployment', environment: 'p/*' }, command: ['smoke'] });
  const evidence = {
    headSha: 'sha',
    command: ['smoke'],
    readyWaitMs: 1,
    durationMs: 1,
    artifacts: [],
    reason: 'never ready',
  };
  const PREVIEW_FAIL: ShipResult = {
    ok: false,
    prNumber: 9,
    reason: 'preview check preview-unavailable for PR #9: never ready',
    previewCheck: { status: 'preview-unavailable', evidence },
    headSha: 'sha',
  };
  function rig(queued: ShipResult[], previewConfig: RunPorts['loadPreviewConfig'] = () => PREVIEW) {
    const events: { type: string; msg: string }[] = [];
    const ships: Parameters<NonNullable<RunPorts['shipPhase']>>[0][] = [];
    const reworks: Parameters<NonNullable<RunPorts['reworkWorker']>>[0][] = [];
    const results = [...queued];
    let checks = 0;
    const rigged: RunPorts = {
      ...ports((type, msg) => {
        events.push({ type, msg });
      }),
      loadPreviewConfig: previewConfig,
      shipPhase: async (o) => {
        ships.push(o);
        return results.length > 1 ? (results.shift() as ShipResult) : results[0];
      },
      reworkWorker: async (o) => {
        reworks.push(o);
        return { failovers: [], modelCompleted: true };
      },
      checkPhase: async () => {
        checks += 1;
        return CHECK_OK;
      },
    };
    return { rigged, ships, reworks, events, checks: () => checks };
  }

  it('passes no previewGate to SHIP when the repo has no preview config', async () => {
    const { rigged, ships } = rig([{ ok: true, prNumber: 9 }], () => undefined);
    await runIssue(request, policy, rigged);
    expect(ships[0]).not.toHaveProperty('previewGate');
  });

  it('a failed preview check runs a rework round, re-checks and re-enters SHIP', async () => {
    const { rigged, ships, reworks, events, checks } = rig([PREVIEW_FAIL, { ok: true, prNumber: 9 }]);
    expect(await runIssue(request, policy, rigged)).toMatchObject({ state: 'ready' });
    expect(ships[0]).toHaveProperty('previewGate');
    expect(reworks[0].extraInstructions).toContain('deployed preview failed');
    expect(reworks[0].summary.results[0].details).toContain('Preview check: preview-unavailable');
    expect(checks()).toBe(2);
    expect(ships[1]).toMatchObject({ reentry: { prNumber: 9 } });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'rework',
        msg: 'CI rework round 1/2: preview check preview-unavailable on PR #9',
      }),
    );
  });

  it('parks fail with the preview reason when the rework budget is exhausted', async () => {
    const { rigged, reworks, events } = rig([PREVIEW_FAIL]);
    expect(await runIssue(request, policy, rigged)).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(reworks).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'fail',
        msg: 'ship phase failed: preview check preview-unavailable for PR #9: never ready — preview rework budget exhausted after 2 rounds',
      }),
    );
  });

  it('applies the suppression guard to preview rework', async () => {
    const { rigged, ships } = rig([PREVIEW_FAIL]);
    readReworkDiff.mockResolvedValue(
      'diff --git a/max-lines-baseline.json b/max-lines-baseline.json\n--- a/max-lines-baseline.json\n+++ b/max-lines-baseline.json\n@@ -3 +3 @@\n-  "a.ts": 789,\n+  "a.ts": 790,\n',
    );
    expect(await runIssue(request, policy, rigged)).toMatchObject({ reason: 'ci-failed' });
    expect(ships).toHaveLength(1);
  });

  it('does not spend a rework round while CI is pending and parks fail with the reason', async () => {
    const pending: ShipResult = {
      ok: false,
      prNumber: 9,
      reason: 'preview check preview-unavailable for PR #9: CI pending, preview not checked',
      previewCheck: {
        status: 'preview-unavailable',
        evidence: { ...evidence, reason: 'CI pending, preview not checked' },
      },
      ciOutcome: 'timeout',
      ciPending: true,
      draft: true,
      headSha: 'sha',
    };
    const { rigged, ships, reworks, events } = rig([pending]);
    expect(await runIssue(request, policy, rigged)).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(reworks).toHaveLength(0);
    expect(ships).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'fail',
        msg: 'ship phase failed: preview check preview-unavailable for PR #9: CI pending, preview not checked',
      }),
    );
  });
});
